/**
 * RSI bridge service — 双轨并存的"旁路对账件"。
 *
 * 职责：
 *   1. 从 DB 取回上一轮成功判决的 AgentRunResult，重建 prev Manifest
 *   2. 用 manifest-builder 把当前 run 的 verdicts 转成 next Manifest
 *   3. spawn krsi CLI，喂 prev/next，拿四态 verdict
 *   4. 写入 policy_rsi_runs 表（审计记录）
 *
 * 设计约束：
 *   - 失败不阻断主流程：catch 所有异常，console.warn 就行（跟 JudgeService.judgeDeep 同口径）
 *   - 首次运行（无 prev）→ skip，写 verdict=skipped，不走 krsi
 *   - 每 session 独立落账本（ledger 文件放在 agentDb 旁边）
 *
 * 退出码语义（来自 krsi main.go）：
 *   0 = improved（算数）
 *   1 = not_improved（读数不支持）
 *   2 = refused（拒收，点名哪条 R 判据）
 *   3 = undecidable（量不到）
 *
 *   任何其他 exit code → 视为 bridge 自身故障（构建挂了 / 超时）
 *   krsi 二进制不存在 → skipped（仪器没装，不做对账；不是判据故障）
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile, mkdir, rm, appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Db } from '../../repositories/db.js';
import { buildManifest, hasScoredObjective, type RsiManifest, type RsiArtifact } from './manifest-builder.js';
import { canonicalJson } from './ledger-verify.js';
import type { CriterionVerdict } from '../judge/types.js';
import {
  readSuiteScores,
  suiteFloorVerdict,
  SUITE_FLOOR_CRITERION,
  type SuiteScore,
} from '../judge/eval-rate.js';

export type RsiVerdictState = 'improved' | 'not_improved' | 'refused' | 'undecidable' | 'skipped' | 'error';

export interface RsiBridgeResult {
  state: RsiVerdictState;
  /** krsi exit code —— skipped/error 时为 null。 */
  exitCode: number | null;
  reasons: string[];
  /** 解析自报告的 per-metric 对比结果（improved/not_improved 时有）。 */
  metrics?: Array<{ metric: string; before: number; after: number; better: boolean }>;
  /** 完整报告原文（供审计）。 */
  reportRaw: string;
  /** 账本文件路径。L1 还没做 Anchor，所以账本只当 artifact 存着。 */
  ledgerPath: string;
}

export interface RsiBridgeDeps {
  db: Db;
  /** krsi 可执行文件路径。默认 '/tmp/krsi'，实际安装位置可以覆盖。 */
  krsiPath?: string;
  /** agentDb 所在目录 —— 账本 JSONL 放这里的 rsi/ 子目录。 */
  dbDir: string;
  /** 生产者标识，传给 Manifest.producer。 */
  producer?: string;
  /** 单次 krsi 超时 ms。默认 10s，L1 不需要花时间。 */
  timeoutMs?: number;
}

const DEFAULT_KRSI_PATH = '/tmp/krsi';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PRODUCER = 'codelens-agentkernel';

/** policy_rsi_runs 表的最小 DB 表面（跟 schema.ts MigrationDb 同口径）。 */
interface RsiDb {
  exec(sql: string): void;
  run(sql: string, params?: unknown): unknown;
  get<T = unknown>(sql: string, params?: unknown): T | undefined;
  all<T = unknown>(sql: string, params?: unknown): T[];
}

export class RsiBridgeService {
  private readonly krsiPath: string;
  private readonly dbDir: string;
  private readonly producer: string;
  private readonly timeoutMs: number;
  private readonly rsiDir: string;

  constructor(private readonly deps: RsiBridgeDeps) {
    this.krsiPath = deps.krsiPath ?? DEFAULT_KRSI_PATH;
    this.dbDir = deps.dbDir;
    this.producer = deps.producer ?? DEFAULT_PRODUCER;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.rsiDir = path.join(this.dbDir, 'rsi');
  }

  /**
   * 主入口：对当前 run 做跨代对比。
   *
   * generation 由 **session 内已有的 policy_rsi_runs 数量 + 1** 自动决定，
   * 彻底隔离 seed session 和真实 session —— 每个 session 的 RSI 代序独立计数。
   * 不需要外部（PolicyRepository）传 generation，消除 session 间串扰。
   */
  async compare(
    sessionId: string,
    _generationHint: number,
    runVerdicts: CriterionVerdict[],
    judgeRunId: number,
    /** 采样次数（默认 1）。>1 时把最近 N-1 次判决一并取均值，压制单次作答的随机波动。 */
    samples = 1,
  ): Promise<RsiBridgeResult> {
    // ── 多样本均值：同一探针跑 N 次，读数取均值 ────────────────────────────
    // 单次作答的 goal_term_coverage 波动可达 ±0.03，直接把两次单样本相减
    // 等于拿掷骰子的结果判"进步"。N 次取均值把标准差压到 1/√N，
    // 才让 R5 的"严格变好"对应真实差异而不是噪声。
    const effectiveVerdicts =
      samples > 1
        ? averageVerdicts([
            ...this.fetchRecentVerdicts(sessionId, judgeRunId, samples - 1),
            runVerdicts,
          ])
        : runVerdicts;

    // ── 无效测量不落代 ────────────────────────────────────────────────────────
    // 探针没产出**任何**目标读数（空回答 / 全部未执行）时，落代只会堆满
    // undecidable，generation 被推高却没有任何可比读数。
    // 注意：不能只认语义判据 —— 代码修复族的目标是 task.test_pass_rate，
    // 该判据有分就说明这一代确实量到了东西（见 hasScoredObjective）。
    const hasObjectiveScore = hasScoredObjective(effectiveVerdicts);
    if (!hasObjectiveScore) {
      return {
        state: 'skipped',
        exitCode: null,
        reasons: ['探针未产生可测的目标读数（空回答或未执行），本代不计'],
        reportRaw: '',
        ledgerPath: '',
      };
    }
    // ── 自动决定 session-scoped generation ────────────────────────────────────
    const prevGenRow = this.deps.db.get<{ generation: number; next_manifest_json: string | null }>(
      `SELECT generation, next_manifest_json FROM policy_rsi_runs
        WHERE session_id = ? ORDER BY generation DESC LIMIT 1`,
      [sessionId],
    );
    const prevGeneration = prevGenRow?.generation ?? 0;
    const generation = prevGeneration + 1;

    const ledgerPath = path.join(this.rsiDir, `${safe(sessionId)}.jsonl`);
    const reportPath = path.join(this.rsiDir, `${safe(sessionId)}-gen${generation}.txt`);
    const prevPath = path.join(this.rsiDir, `${safe(sessionId)}-prev-gen${prevGeneration}.json`);
    const nextPath = path.join(this.rsiDir, `${safe(sessionId)}-next-gen${generation}.json`);

    try {
      await mkdir(this.rsiDir, { recursive: true });

      // ── 把 L2 深判子行也喂进来（如果有） ────────────────────────────────────
      // 深判是 post-hoc 触发的，它在 judge_runs 里是 parent_run=本轮 runId 的子行。
      // 这里查一下，有深判行就把它作为一个额外的 semantic.completion verdict
      // 喂进 manifest（basis=2 Relayed），让 krsi 跨代能判语义评分严格变好。
      let enrichedVerdicts: CriterionVerdict[] = effectiveVerdicts;
      const deepRow = this.deps.db.get<{ verdict: string; score: number }>(
        `SELECT verdict, score FROM judge_runs WHERE parent_run = ? LIMIT 1`,
        [judgeRunId],
      );
      if (deepRow && ['pass', 'fail', 'inconclusive'].includes(deepRow.verdict)) {
        enrichedVerdicts = [
          ...runVerdicts,
          {
            layer: 'L2',
            criterion: 'semantic.completion',
            status: deepRow.verdict === 'pass' ? 'pass' : 'fail',
            score: deepRow.score,
            detail: `深判 score=${deepRow.score.toFixed(3)}`,
          },
        ];
      }

      // ── 0.5 套件级地板（护栏）：堵住「修 A 打坏 B，整机率仍上涨」的假绿 ──────
      // task.test_pass_rate 是整机聚合率，两个套件可以互相抵消：
      // 实测注入 parse_query 2/8→8/8（+6）同时 csv_import 7/17→2/17（-5），
      // 整机率 0.691→0.699，krsi 判 improved 并写「全部指标严格变好」。
      // 基线取**上一代证据文件**里的套件明细 —— manifest 只搬标量，
      // 逐个套件的读数只存在于 evidence（evalPassRateGate 的 data.suites）。
      // 读不到基线时记 absent 而不是不产出：否则 R3 会把「量不到」判成「删指标」。
      if (prevGeneration > 0) {
        const curSuites = readSuiteScores(enrichedVerdicts);
        let prevSuites: SuiteScore[] | null = null;
        try {
          const prevEvidence = await readFile(
            path.join(this.rsiDir, `${safe(sessionId)}-gen${prevGeneration}-evidence.json`),
            'utf8',
          );
          prevSuites = readSuiteScores(
            (JSON.parse(prevEvidence) as { verdicts?: CriterionVerdict[] }).verdicts ?? [],
          );
        } catch {
          prevSuites = null;
        }
        const floor = suiteFloorVerdict(prevSuites, curSuites);
        enrichedVerdicts = [
          ...enrichedVerdicts,
          floor ?? {
            layer: 'L1',
            criterion: SUITE_FLOOR_CRITERION,
            status: 'unexec',
            detail: prevSuites
              ? '本代没有套件级读数，套件地板无法计算'
              : `上一代（第 ${prevGeneration} 代）无可用的套件明细，套件地板无基线`,
          },
        ];
      } else {
        // 首代：确立基线。
        // 没有更早的读数可比，"不回退"在本代真空成立 —— 这不是测量结论，
        // 但必须写成 1.0 而不是 absent：否则下一代取 prev 时这条指标不存在，
        // 护栏在**第一次加入的那一代**完全失效（实测：prev 无该指标时仍判 improved）。
        // detail 明确标注这是基线确立，避免被当成"13 个套件全部通过"。
        const curSuites = readSuiteScores(enrichedVerdicts);
        if (curSuites) {
          enrichedVerdicts = [
            ...enrichedVerdicts,
            {
              layer: 'L1',
              criterion: SUITE_FLOOR_CRITERION,
              status: 'pass',
              score: 1,
              detail: `套件地板：确立基线（${curSuites.length} 个套件），本代无可比对象`,
              data: { baseline: curSuites.map((s) => `${s.id} ${s.passed}/${s.total}`) },
            },
          ];
        }
      }

      // ── 0. 钉住本轮判决的证据原像 ─────────────────────────────────────────────
      // krsi 的 R4「可锚」判据要的不是一个 64 位占位串，而是
      // 「这个 manifest 指着一个真实存在、内容哈希对得上的证据文件」。
      // 所以每代都把判决证据（judgeRunId + 全部 verdicts + 采集时间）落盘，
      // 用文件内容的真 sha256 + 真字节数作为 artifacts。
      // 证据文件永久保留（不随临时 manifest 一起删），下一代/审计都能回查。
      const evidencePath = path.join(this.rsiDir, `${safe(sessionId)}-gen${generation}-evidence.json`);
      const evidenceBody = JSON.stringify(
        {
          sessionId,
          generation,
          judgeRunId,
          capturedAt: new Date().toISOString(),
          verdicts: enrichedVerdicts,
        },
        null,
        2,
      );
      await writeFile(evidencePath, evidenceBody);
      const evidenceSha256 = createHash('sha256').update(evidenceBody, 'utf8').digest('hex');
      const evidenceBytes = Buffer.byteLength(evidenceBody, 'utf8');

      // ── 1. 构建 next Manifest ────────────────────────────────────────────────
      const nextManifest = buildManifest({
        producer: this.producer,
        generation,
        verdicts: enrichedVerdicts,
        artifacts: [
          {
            // 路径要相对 **进程 cwd**：krsi 以继承的 cwd 解析产物路径做内容哈希复核。
            // 之前写的是相对 dbDir（"rsi/..."），krsi 在 server 根下找不到文件，
            // R4 就退化成「只校验 64 位格式」—— 看起来在锚定，其实没验内容。
            path: path.relative(process.cwd(), evidencePath),
            sha256: evidenceSha256,
            bytes: evidenceBytes,
          },
        ],
      });
      await writeFile(nextPath, JSON.stringify(nextManifest, null, 2));

      // ── 2. 取 prev：优先复用上一代**落库的 manifest 原文** ───────────────────
      // 为什么必须复用原文、不能从 judge_verdicts 重建：
      //   krsi 的 R6 会比对「链上已记录的某一代 manifest」，重建只要有一个字节不同
      //   （字段顺序、L2 深判行是否已落库、证据产物的哈希……）就会被判
      //   「同一代存在两份不同 manifest」而整代拒收。
      // 重建只作为旧数据的兜底（列还没写过的历史行）。
      const prevManifest = prevGeneration > 0
        ? await this.loadPrevManifest(
            sessionId,
            prevGeneration,
            prevGenRow?.next_manifest_json ?? null,
            judgeRunId,
          )
        : null;
      if (!prevManifest) {
        const skipped: RsiBridgeResult = {
          state: 'skipped',
          exitCode: null,
          reasons: ['首次运行：无可对比的上一代 manifest'],
          reportRaw: '',
          ledgerPath,
        };
        // 首次运行也要把本代 manifest 落库：否则下一代取 prev 时读到 NULL，
        // 会退回「从 judge_runs 重建」，而重建取到的是**当前轮**的判决，
        // 于是 prev 与 next 读数永远相同（R5 恒判没变好）。这是整条链的起点，
        // 第一代不存 = 第二代必错。
        await this.recordRun(judgeRunId, sessionId, generation, skipped, null, nextManifest);
        return skipped;
      }
      // 缩进必须与 nextPath 完全一致：prev 复用的是上一代落库原文，
      // 若这一侧用紧凑 JSON 写盘、那一侧用 2 空格缩进，同一个对象会得到不同字节，
      // R6 的「同一代 manifest 必须逐字节一致」就会误报。统一 2 空格。
      await writeFile(prevPath, JSON.stringify(prevManifest, null, 2));

      // ── 3. spawn krsi ────────────────────────────────────────────────────────
      const result = await this.spawnKrsi(prevPath, nextPath, reportPath, ledgerPath);
      await this.recordRun(judgeRunId, sessionId, generation, result, prevManifest, nextManifest);

      // ── 4. Anchor 落链 ───────────────────────────────────────────────────────
      // 给**独立的**锚链文件追加一条带 manifest sha256 的 Anchor 行。
      //
      // 绝不能写进 krsi 自己的 ledger：那张账本是 krsi 的私有格式
      // （seq/actor/payload_b64/prev_hash 链），混入外来行后它的 R6 账本校验
      // 无法解析，从下一代起会直接 precheck 拒收（exit 2、连报告都不写）。
      // 实测症状：g1→g2 正常，g3 起全部 refused。
      await this.appendAnchor(this.anchorPath(sessionId), generation, nextManifest, prevManifest, result);

      // 清理临时 manifest（账本 JSONL 保留）
      await Promise.allSettled([rm(prevPath, { force: true }), rm(nextPath, { force: true })]);
      return result;
    } catch (err) {
      const failed: RsiBridgeResult = {
        state: 'error',
        exitCode: null,
        reasons: [err instanceof Error ? err.message : String(err)],
        reportRaw: '',
        ledgerPath,
      };
      // 即使是异常也记一笔 —— 否则"桥挂了"这件事在审计面上完全隐形
      try { this.recordRun(judgeRunId, sessionId, generation, failed, null, null); } catch { /* ignore */ }
      return failed;
    }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  /**
   * 取当前判决之前的最近 N 次判决（按 run 分组，最新的在前）。
   *
   * 只用于多样本均值：调用方保证这 N 次运行是**同一探针**的连续采样。
   * 用 judge_verdicts 还原而不依赖 judge_runs.context_json —— 后者是压缩快照，
   * 解析它等于把测量逻辑绑在一个会变的序列化格式上。
   */
  private fetchRecentVerdicts(
    sessionId: string,
    beforeRunId: number,
    limit: number,
  ): CriterionVerdict[][] {
    if (limit <= 0) return [];
    const rows = this.deps.db.all<{
      run_id: number;
      layer: string;
      criterion: string;
      status: string;
      score: number | null;
      detail: string | null;
    }>(
      `SELECT run_id, layer, criterion, status, score, detail
         FROM judge_verdicts
        WHERE session_id = ? AND run_id < ?
        ORDER BY run_id DESC, id ASC`,
      [sessionId, beforeRunId],
    );

    const byRun = new Map<number, CriterionVerdict[]>();
    for (const r of rows) {
      let list = byRun.get(r.run_id);
      if (!list) {
        if (byRun.size >= limit) break; // 只要最近 N 次，更早的不再收集
        list = [];
        byRun.set(r.run_id, list);
      }
      list.push({
        layer: r.layer as CriterionVerdict['layer'],
        criterion: r.criterion,
        status: r.status as CriterionVerdict['status'],
        detail: r.detail ?? undefined,
        ...(r.score === null ? {} : { score: r.score }),
      });
    }
    return [...byRun.values()];
  }

  /**
   * 取上一代 Manifest：落库原文优先，缺失时才从判决重建。
   *
   * 复用原文是 R6 能连续通过的前提（见 compare() 里的说明）。
   */
  private async loadPrevManifest(
    sessionId: string,
    prevGeneration: number,
    storedJson: string | null,
    judgeRunId: number,
  ): Promise<RsiManifest | null> {
    if (storedJson) {
      try {
        return JSON.parse(storedJson) as RsiManifest;
      } catch {
        // 原文损坏 → 退回重建，至少不阻断
      }
    }
    return this.fetchPrevManifest(sessionId, prevGeneration, judgeRunId);
  }

  /**
   * 从上一次 Agent 判决重建 prev Manifest。
   *
   * 实现：查 judge_runs 找 session **当前 run 之前**的最近一次判决，
   * 读其 verdicts，重建 buildManifest。
   *
   * 必须显式排除当前 run（id < currentRunId）：当前判决此时已经落库，
   * 只按 created_at DESC 取第一条会取到自己，prev 与 next 读数就永远相同。
   *
   * 返回 null 表示"没有上一代"（首次运行 / session 没有历史判决）。
   */
  private async fetchPrevManifest(
    sessionId: string,
    prevGeneration: number,
    excludeRunId: number,
  ): Promise<RsiManifest | null> {
    const prevRun = this.deps.db
      .get<{ id: number; context_json: string | null }>(
        `SELECT id, context_json FROM judge_runs
         WHERE session_id = ? AND verdict IS NOT NULL AND id < ?
         ORDER BY id DESC LIMIT 1`,
        [sessionId, excludeRunId],
      );
    if (!prevRun) return null;

    const rows = this.deps.db.all<{
      layer: string;
      criterion: string;
      status: string;
      score: number | null;
      detail: string | null;
    }>(
      `SELECT layer, criterion, status, score, detail
         FROM judge_verdicts
        WHERE run_id = ? AND session_id = ?`,
      [prevRun.id, sessionId],
    );
    if (rows.length === 0) return null;

    const verdicts: CriterionVerdict[] = rows.map((r) => ({
      layer: r.layer as CriterionVerdict['layer'],
      criterion: r.criterion,
      status: r.status as CriterionVerdict['status'],
      score: r.score ?? undefined,
      detail: r.detail ?? undefined,
    }));

    // 上一代的证据原像若还在盘上，就用真实文件重算哈希/字节数；
    // 这样 prev 与 next 两侧的 artifacts 口径一致，都是"可回查的真文件"，
    // 而不是一边真一边占位。
    const artifacts = await this.readEvidenceArtifact(sessionId, Math.max(1, prevGeneration));

    return buildManifest({
      producer: this.producer,
      generation: Math.max(1, prevGeneration),
      verdicts,
      artifacts,
    });
  }

  /**
   * 读某代的证据原像文件，返回可校验的 artifact 描述。
   * 文件不存在（历史遗留代 / 首次运行）→ undefined，由 buildManifest 走 readings 兜底。
   */
  private async readEvidenceArtifact(
    sessionId: string,
    generation: number,
  ): Promise<RsiArtifact[] | undefined> {
    const p = path.join(this.rsiDir, `${safe(sessionId)}-gen${generation}-evidence.json`);
    try {
      const body = await readFile(p);
      return [
        {
          // 与 next 侧同口径：相对进程 cwd，krsi 才能真的复核内容哈希
          path: path.relative(process.cwd(), p),
          sha256: createHash('sha256').update(body).digest('hex'),
          bytes: body.byteLength,
        },
      ];
    } catch {
      return undefined;
    }
  }

  /** 锚链文件（与 krsi 的私有账本严格分离，见 compare() 里的说明）。 */
  private anchorPath(sessionId: string): string {
    return path.join(this.rsiDir, `${safe(sessionId)}-anchors.jsonl`);
  }

  /**
   * 给锚链文件追加一条带 manifest sha256 的 Anchor 行，形成哈希链。
   *
   * 版本口径（见 `rsi-loop.md` §6）：
   *   · v1 = 历史行：`JSON.stringify` 固定键序，只覆盖 prev/manifest/verdict/exit/gen/ts；
   *   · v2 = 新行：canonical JSON，并补全 §6 证据原像（prev/next manifest、verdict、
   *     exit_code、reasons、metrics、report_raw）。原像本体随行落盘，离线即可复算。
   *
   * 追加时**只写新行**：旧行缺 `hash_version` 一律按 v1 解释，绝不回写或重签历史。
   *
   * microkernel-rsi 的 R6 判据下次可以直接校验链完整性：任一环的 manifest 被篡改
   * 都会导致 anchor_hash 对不上，整条链变红。
   *
   * 失败不抛：Anchor 是 P3 增强，不是主流程必要项。ledger 写坏了就写坏了，
   * 不能因此让 bridge 自身 verdict 变成 error。
   */
  private async appendAnchor(
    ledgerPath: string,
    generation: number,
    manifest: RsiManifest,
    prevManifest: RsiManifest | null,
    result: RsiBridgeResult,
  ): Promise<void> {
    try {
      const manifestHash = createHash('sha256')
        .update(JSON.stringify(manifest))
        .digest('hex');
      const prevManifestHash = prevManifest
        ? createHash('sha256').update(JSON.stringify(prevManifest)).digest('hex')
        : null;

      // 读上一个 anchor_hash（作为 prev_anchor_hash），形成链
      let prevAnchorHash: string | null = null;
      try {
        const content = await readFile(ledgerPath, 'utf-8');
        const lastLine = content.trim().split('\n').pop();
        if (lastLine) {
          const last = JSON.parse(lastLine) as { type?: string; anchor_hash?: string };
          // krsi 本身也会往 ledger 写 metric 行——只取 type='anchor' 的才是上一个锚点
          if (last.type === 'anchor' && last.anchor_hash) {
            prevAnchorHash = last.anchor_hash;
          }
        }
      } catch {
        // ledger 还没内容（首次运行）或格式不对 → prev=null，链头从 null 开始
      }

      const ts = Date.now();
      const evidence = {
        gen: generation,
        producer: this.producer,
        prev_manifest: prevManifest,
        next_manifest: manifest,
        verdict: result.state,
        exit_code: result.exitCode,
        reasons: result.reasons,
        metrics: result.metrics ?? [],
        report_raw: result.reportRaw,
      };
      const evidenceHash = createHash('sha256')
        .update(canonicalJson(evidence))
        .digest('hex');

      const anchorInput = canonicalJson({
        prev_anchor: prevAnchorHash,
        manifest_hash: manifestHash,
        prev_manifest_hash: prevManifestHash,
        evidence_hash: evidenceHash,
        verdict: result.state,
        exit_code: result.exitCode,
        generation,
        timestamp: ts,
      });
      const anchorHash = createHash('sha256').update(anchorInput).digest('hex');

      const anchor = {
        type: 'anchor' as const,
        hash_version: 2,
        generation,
        anchor_hash: anchorHash,
        prev_anchor_hash: prevAnchorHash,
        manifest_hash: manifestHash,
        prev_manifest_hash: prevManifestHash,
        evidence_hash: evidenceHash,
        verdict: result.state,
        exit_code: result.exitCode,
        timestamp: ts,
        evidence,
      };
      await appendFile(ledgerPath, JSON.stringify(anchor) + '\n');
    } catch {
      // Anchor 落链失败不阻断主流程——P3 是增强不是必要项
    }
  }

  /** spawn krsi，等待结果，解析报告。 */
  private async spawnKrsi(
    prevPath: string,
    nextPath: string,
    reportPath: string,
    ledgerPath: string,
  ): Promise<RsiBridgeResult> {
    // 预检：krsi 没装（沙箱重置后 /tmp/krsi 消失、或在 Windows 上跑）时，
    // spawn 只会抛一个 ENOENT，代际被记成 error —— 看起来像判据坏了，其实是仪器没装。
    // 这里明确降级为 skipped：本代读数仍写入，只是不做代际对账。
    if (!existsSync(this.krsiPath)) {
      return {
        state: 'skipped',
        exitCode: null,
        reasons: [`krsi 未安装：${this.krsiPath}（用 KRSI_BIN_PATH 指向已编译的二进制）`],
        reportRaw: '',
        ledgerPath,
      };
    }
    return new Promise<RsiBridgeResult>((resolve) => {
      const args = [prevPath, nextPath, reportPath, ledgerPath];
      const proc = spawn(this.krsiPath, args, {
        timeout: this.timeoutMs,
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', (err) => {
        resolve({
          state: 'error',
          exitCode: null,
          reasons: [`krsi spawn error: ${err.message}`],
          reportRaw: stdout + (stderr ? `\n--- stderr ---\n${stderr}` : ''),
          ledgerPath,
        });
      });
      proc.on('close', (code) => {
        // 尝试读报告文件（krsi 写到磁盘比 stdout 更完整）
        this.readReportFile(reportPath)
          .then((reportRaw) => {
            const report = reportRaw || stdout;
            resolve({
              state: parseExitCode(code),
              exitCode: code,
              reasons: extractReasons(report),
              metrics: extractMetrics(report),
              reportRaw: report || stdout + stderr,
              ledgerPath,
            });
          })
          .catch(() => {
            resolve({
              state: parseExitCode(code),
              exitCode: code,
              reasons: extractReasons(stdout),
              metrics: extractMetrics(stdout),
              reportRaw: stdout + (stderr ? `\n--- stderr ---\n${stderr}` : ''),
              ledgerPath,
            });
          });
      });
    });
  }

  private async readReportFile(p: string): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    return readFile(p, 'utf8');
  }

  /** 把 bridge 结果落审计表。失败不抛——外层 catch 住。 */
  private recordRun(
    judgeRunId: number,
    sessionId: string,
    generation: number,
    result: RsiBridgeResult,
    prevManifest: RsiManifest | null,
    nextManifest: RsiManifest | null,
  ): void {
    const metrics = result.metrics ? JSON.stringify(result.metrics) : null;
    this.deps.db.run(
      `INSERT INTO policy_rsi_runs
         (judge_run_id, session_id, generation, prev_generation,
          verdict, exit_code, reasons_json, metrics_json,
          prev_readings_json, next_readings_json, next_manifest_json,
          ledger_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        judgeRunId,
        sessionId,
        generation,
        prevManifest?.generation ?? null,
        result.state,
        result.exitCode,
        JSON.stringify(result.reasons),
        metrics,
        prevManifest ? JSON.stringify(prevManifest.readings) : null,
        nextManifest ? JSON.stringify(nextManifest.readings) : null,
        // 原文落库：下一代直接复用，保证与链上记录逐字节一致
        nextManifest ? JSON.stringify(nextManifest) : null,
        result.ledgerPath,
        Date.now(),
      ],
    );
  }
}

// ── krsi 输出解析 ──────────────────────────────────────────────────────────

function parseExitCode(code: number | null): RsiVerdictState {
  switch (code) {
    case 0: return 'improved';
    case 1: return 'not_improved';
    case 2: return 'refused';
    case 3: return 'undecidable';
    default: return 'error'; // null / 其他数字
  }
}

/**
 * 多样本判决均值（纯函数，供单测钉死）。
 *
 * 只对**当前这一轮**已有的判据求均值：老采样里多出来的判据不引入，
 * 避免"上一轮跑过深判、这一轮没跑"就把测量口径偷偷改宽。
 *
 * status 取最坏：任一次 fail 就是 fail（一次没做成不能靠均值洗掉）；
 * 全 unexec 才算 unexec。score 取算术平均并保留 3 位小数。
 */
export function averageVerdicts(sampleSets: CriterionVerdict[][]): CriterionVerdict[] {
  const current = sampleSets[sampleSets.length - 1] ?? [];
  if (sampleSets.length <= 1) return current;

  const agg = new Map<string, { statuses: CriterionVerdict['status'][]; scores: number[] }>();
  for (const set of sampleSets) {
    for (const v of set) {
      let a = agg.get(v.criterion);
      if (!a) {
        a = { statuses: [], scores: [] };
        agg.set(v.criterion, a);
      }
      a.statuses.push(v.status);
      if (typeof v.score === 'number' && Number.isFinite(v.score)) a.scores.push(v.score);
    }
  }

  return current.map((v) => {
    const a = agg.get(v.criterion);
    if (!a) return v;
    const status: CriterionVerdict['status'] = a.statuses.includes('fail')
      ? 'fail'
      : a.statuses.includes('pass')
        ? 'pass'
        : 'unexec';

    // 有效样本不足一半 → 这一代不产出读数（下游按 absent 处理）。
    // 允许少数样本失败（上游偶发空回答），但不能只拿"成功的那一次"当整代读数：
    // 3 次里只有 1 次有读数就求均值，等于把测量噪声洗成成绩。
    const minValid = Math.ceil(sampleSets.length / 2);
    if (a.scores.length < minValid) {
      return {
        ...v,
        status,
        score: undefined,
        detail: `${v.detail ?? ''}｜${a.scores.length}/${sampleSets.length} 次采样有读数（不足一半），样本不完整`.trim(),
      };
    }

    const avg = a.scores.reduce((x, y) => x + y, 0) / a.scores.length;
    return {
      ...v,
      status,
      score: Math.round(avg * 1000) / 1000,
      detail: `${v.detail ?? ''}｜${a.scores.length}/${sampleSets.length} 次采样均值 ${avg.toFixed(3)}`.trim(),
    };
  });
}

/** 从 krsi 报告里抓「理由」段落（R5 的未变好理由、R3 的拒收点名等）。 */
function extractReasons(report: string): string[] {
  const reasons: string[] = [];
  const lines = report.split('\n');
  let inReasons = false;
  for (const line of lines) {
    if (line.startsWith('理由：')) {
      inReasons = true;
      const rest = line.slice('理由：'.length).trim();
      if (rest && rest !== '（无 —— 全部指标严格变好）') {
        reasons.push(rest);
      }
      continue;
    }
    if (inReasons) {
      // 理由段结束于下一空行 / 锚定行 / 边界行
      if (line.startsWith('锚定') || line.startsWith('边界') || line.startsWith('退出码')) break;
      const trimmed = line.trim();
      if (trimmed) reasons.push(trimmed);
    }
  }
  // 兜底：拒收/核不了时，krsi 可能把 R 判据点名写在"判定"之前
  if (reasons.length === 0) {
    for (const line of lines) {
      // 匹配形如 "R1: ..." "R2: ..." "R5: ..." 的判据点名
      const m = line.match(/(R[1-6]:[^\n]+)/g);
      if (m) reasons.push(...m);
    }
  }
  return reasons;
}

/**
 * 从 krsi 报告里抓 per-metric 对比行。
 *
 * 真实行格式（由 main.go:582 生成）：
 *   "  · 指标名：旧值 → 新值（变好=true）（护栏：不得变差）"
 * 指标名与数值之间的分隔符是**全角冒号**（U+FF1A）。这里原先只写了半角 ":",
 * 与报告实际输出对不上，于是真实报告一条都匹配不到、metrics_json 恒为 null ——
 * 判决一直有，per-metric 明细却从来是空的。
 *
 * 同时兼容历史报告的半角写法，并容忍半角括号与 "->" 箭头。
 * 导出仅为可测：报告行格式是字节级契约，改动会被 rsi-report-metrics 测试打红。
 */
export function extractMetrics(report: string): RsiBridgeResult['metrics'] {
  const out: NonNullable<RsiBridgeResult['metrics']> = [];
  const metricLine =
    /^\s*·\s*(\S+?)\s*[：:]\s*(-?\d+(?:\.\d+)?)\s*(?:→|->)\s*(-?\d+(?:\.\d+)?)\s*[（(]\s*变好\s*=\s*([^）)]*?)\s*[）)]/;
  for (const line of report.split('\n')) {
    const m = line.match(metricLine);
    if (m && m[1] !== undefined) {
      out.push({
        metric: m[1],
        before: Number(m[2] ?? 0),
        after: Number(m[3] ?? 0),
        better: m[4] === 'true',
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
}
