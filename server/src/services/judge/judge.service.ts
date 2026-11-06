/**
 * Judge service — 闭环的 `Judge` 一步（强化内核宣言第 1、3 节）。
 *
 *   Improve(π) = π --Act--> τ --Judge--> r --Update--> π'
 *
 * 它做三件事，缺一不可：
 *   1. 从 τ（tool_calls / approvals / messages / 运行期元数据）抽取证据；
 *   2. 跑判据塔 L0–L3，产出结构化 r（含 unexec，不把「没测」说成「通过」）；
 *   3. 计算覆盖率并按门槛定档 —— 覆盖率不足时只能 inconclusive。
 *
 * 关键设计：
 *  - L1 金丝雀若不能证明判据具备判别力，本轮 L0 结论整体降级为 unexec。
 *    判据不可信时，它给出的任何绿都不算数（C3）。
 *  - v2：覆盖率分母只算 available 层；不可用层既不给绿也不占名额。
 *  - v2：判决必须可复算 —— 证据、阈值、金丝雀状态全部进 context_json 快照。
 *  - v2：判据塔自身故障（L1 fail）判 inconclusive，绝不写成「任务失败」。
 *    否则自证故障会被 Update 当成任务失败永久入库，污染经验有效性的分母。
 */

import type { Db } from '../../repositories/db.js';
import type { ToolCallRepository } from '../memory/tool-call.repository.js';
import { JudgeRepository, type JudgeRunRow, type LessonEffectiveness } from '../../repositories/judge.repository.js';
import { L0_CRITERIA, resolveThresholds, type L0Thresholds } from './criteria.js';
import { runCanary, type CanaryOutcome } from './canary.js';
import { buildSemanticEvidence, type SemanticAssessor, type SemanticEvidence } from './semantic.js';
import { summarize } from './summarize.js';
import { encodeSnapshot } from './snapshot-codec.js';
import {
  COVERAGE_VERSION,
  RULES_VERSION,
  evidenceDigestOf,
  parseContextSnapshot,
  replayRun,
  semanticDigestPart,
  type JudgeReplayResult,
  type JudgeRunContextSnapshot,
  type ReplayEvidenceSource,
} from './replay.js';
import { assessDeep, DEEP_ASSESSOR_ID, DEEP_CRITERION, type DeepAssessMeta, type DeepAssessOutcome } from './deep-assessor.js';
import { adversarialClaimEvidence } from './red-team.js';
import {
  aggregateInsight,
  DEFAULT_INSIGHT_LIMIT,
  MAX_DEEP_USAGE_SCAN,
  MAX_INSIGHT_LIMIT,
  type DeepSnapshot,
  type KernelInsight,
} from './insight.js';
import { resolveBaseUrl } from '../../providers/registry.js';
import {
  COVERAGE_THRESHOLD,
  DEFAULT_LAYER_PROFILES,
  type CriterionVerdict,
  type JudgeEvidence,
  type JudgeLayer,
  type JudgeRunResult,
  type JudgeSummary,
  type LayerProfile,
} from './types.js';

/** 运行期上下文：loop 结束时才知道、且不在 τ 里的信息。 */
export interface JudgeRuntimeContext {
  finishReason: string;
  iteration: number;
  tokenBudget: number;
  usage: { promptTokens: number; completionTokens: number };
  /** 本轮是否触发过熔断。 */
  circuitOpened: boolean;
}

export interface JudgeDeps {
  db: Db;
  toolCalls: ToolCallRepository;
  /**
   * L2 语义评估器。缺省时 L2 如实声明为不可用（而不是默默记 unexec 混进分母）。
   * 必须是同步纯函数：judge() 是同步方法，异步断言会让判决悬空。
   */
  semantic?: SemanticAssessor;
  /**
   * 服务端兜底凭证（LLM_SERVER_API_KEY）。只用于事后深判：主链的凭证来自
   * 每次请求体，而深判在收尾之后才发生，拿不到当时的请求上下文。
   * 这里刻意只存值不存来源，来源由调用方声明（keySource）。
   */
  serverApiKey?: string;
}

/** 判据塔自证报告：回答「我现在还有没有资格判断别人」。 */
export interface JudgeSelfCheck {
  canary: CanaryOutcome;
  thresholds: L0Thresholds;
  /** 不可用层的声明；未实现就是不可用，不用绿字掩盖。 */
  unimplementedLayers: Array<{ layer: JudgeLayer; reason: string }>;
  profiles: LayerProfile[];
  criteria: Array<{
    criterion: string;
    layer: string;
    pass: number;
    fail: number;
    unexec: number;
    total: number;
  }>;
  totalRuns: number;
}

/**
 * 快照里证据条数的上限：再大就不是判决快照，而是第二个 tool_calls 表。
 * 150 是实测折中：常见任务的工具调用量远低于它，而单条 run 的 context_json
 * 压缩后能稳定落在个位数 KB。
 */
const MAX_SNAPSHOT_TOOL_CALLS = 150;
const MAX_SNAPSHOT_APPROVALS = 200;

/** 深判超时：默认 20s，clamp 到 3–60s。adapter 自带的 60s 兜底太慢，本地计时器才是权威。 */
function clampTimeout(ms?: number): number {
  if (ms === undefined || !Number.isFinite(ms)) return 20_000;
  return Math.min(60_000, Math.max(3_000, Math.trunc(ms)));
}

/** 只取 host：剥掉 userinfo / path / query —— 凭证可能藏在 https://user:pass@host/… 里。 */
function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return 'invalid';
  }
}

/** 洞察视图的窗口上界：与 listRuns 同界，避免前端随手拉一个慢查询。 */
function clampLimit(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_INSIGHT_LIMIT;
  return Math.min(MAX_INSIGHT_LIMIT, Math.max(1, Math.trunc(raw)));
}

/** L2 未接线时的判决：uencxec 而非 pass，且理由写清「缺什么」。 */
function unwiredL2(): CriterionVerdict {
  return {
    layer: 'L2',
    criterion: 'semantic.task_completion',
    status: 'unexec',
    detail: '语义判据需要 SemanticAssessor，当前进程未注入；按 C4 记为未执行而非通过',
  };
}

/** L3 恒为未执行：红队判据依赖 L2 且尚未接入。 */
function unwiredL3(): CriterionVerdict {
  return {
    layer: 'L3',
    criterion: 'adversarial.claim_evidence_match',
    status: 'unexec',
    detail: '没有语义证据（最终回答），声明—证据一致性无从校验',
  };
}

/** 深判的凭据与模型来源。只记来源不记值 —— 事后能回答「谁跑的」，但不泄露凭证。 */
export type DeepKeySource = 'client' | 'server';
export type DeepModelSource = 'env' | 'request' | 'session';

/** 深判的 provider 指纹：进快照，但**永不含 apiKey**。 */
export interface DeepProviderFingerprint {
  providerId: string;
  model: string;
  /** 只取 host：会剥掉 userinfo/path/query —— 凭证可能藏在 URL 里。 */
  baseUrlHost: string;
  keySource: DeepKeySource;
  modelSource: DeepModelSource;
}

export interface JudgeDeepOptions {
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** 只在内存中使用；绝不落快照、不落 detail、不落日志。 */
  apiKey?: string;
  force?: boolean;
  timeoutMs?: number;
}

/** 深判终局。`rejected` 表示被并发闸挡下，调用方应映射成 409/429。 */
export type JudgeDeepStatus = 'ok' | 'unexec' | 'reused' | 'rejected';

export interface JudgeDeepResult {
  status: JudgeDeepStatus;
  parentRun: number;
  /** 新写入（或复用）的判决行 id；未写行为 null。 */
  runId: number | null;
  reused: boolean;
  wroteRow: boolean;
  tier: 'deep';
  /** 深判失败/不可判的原因。 */
  failure?: string;
  reason?: string;
  rejected?: 'in_flight' | 'busy';
  deep: (Omit<DeepAssessMeta, 'provider'> & { provider: DeepProviderFingerprint }) | null;
  verdict?: JudgeSummary['verdict'];
  score?: number;
  coverage?: number;
  reasons: string[];
  verdicts?: CriterionVerdict[];
}

export class JudgeService {
  private readonly repo: JudgeRepository;
  /** 深判并发闸：LLM 调用是真实花钱的外部依赖，不能无上限并发。 */
  private static readonly MAX_CONCURRENT_DEEP = 2;
  private readonly deepInFlight = new Set<number>();
  private deepActive = 0;
  /**
   * 延迟绑定的阈值来源。Judge 需要读 π 的 thresholds 面，而 Update 需要读
   * Judge 的仓储 —— 直接构造期互相注入会成环，故用 setter 在一处断开。
   */
  private thresholdsProvider?: () => Record<string, number> | undefined;

  constructor(private readonly deps: JudgeDeps) {
    this.repo = new JudgeRepository(deps.db);
  }

  /** 绑定 π 的阈值来源（runtime 在构造完 UpdateService 后调用）。 */
  setThresholdsProvider(fn: () => Record<string, number> | undefined): void {
    this.thresholdsProvider = fn;
  }

  /** 只读访问仓储，供控制器与 Update 查询使用。 */
  get repository(): JudgeRepository {
    return this.repo;
  }

  /**
   * 本进程的能力声明。语义评估器接了线，L2 才算 available。
   *
   * L2 一旦 available 就同时是 required：能判就必须判。否则「goal 为空 /
   * 回答被截断」时会静默降级为 unexec，而结论仍然可以是 pass —— 那等于
   * 用「没测」换绿灯，正是 C4 明令禁止的。
   */
  layerProfiles(): LayerProfile[] {
    const assessor = this.deps.semantic;
    return DEFAULT_LAYER_PROFILES.map((p) => {
      if (p.layer === 'L2') {
        return assessor
          ? {
              layer: 'L2' as const,
              available: true,
              required: true,
              reason: null,
              detail: `assessor=${assessor.id}`,
            }
          : p;
      }
      if (p.layer === 'L3') {
        // L3 依赖最终回答文本（与 L2 同源），所以可用性跟 L2 绑定。
        // 但**不设为必需**：纯问答/纯分析任务没有「已完成动作」的声明，
        // 本来就没有可校验对象，设成必需会让这类任务永远 inconclusive。
        // 「没得校验」由判据自己如实报 unexec，不靠层门槛替它兜底。
        return assessor
          ? {
              layer: 'L3' as const,
              available: true,
              required: false,
              reason: null,
              detail: 'claim-evidence',
            }
          : p;
      }
      return p;
    });
  }

  /**
   * 对一次已结束的 Agent 运行作出判决，并把 r 落库。
   * 返回结构同时用于 Update 消费与前端展示。
   */
  judge(sessionId: string, runtime: JudgeRuntimeContext): JudgeRunResult {
    const thresholds = resolveThresholds(this.thresholdsProvider?.() ?? null);
    const evidence = this.collectEvidence(sessionId, runtime);
    const profiles = this.layerProfiles();
    const semanticEvidence = this.deps.semantic
      ? this.collectSemanticEvidence(sessionId, evidence)
      : null;

    // ── L1 金丝雀先跑：判据没资格时，后面跑出来的绿一律作废 ────────────────
    const canary = runCanary(thresholds, L0_CRITERIA, this.deps.semantic);
    const l0Trusted = canary.verdict.status === 'pass';

    const l0 = L0_CRITERIA.map((fn) => fn(evidence, thresholds)).map((v) => {
      if (l0Trusted) return v;
      // 判据本身不可信 → 结论无意义，诚实标注为未执行。
      return {
        ...v,
        status: 'unexec' as const,
        detail: `L0 判据未通过金丝雀自证，本结论作废：${v.detail ?? ''}`.trim(),
      };
    });

    const l2: CriterionVerdict =
      this.deps.semantic && semanticEvidence ? this.deps.semantic.assess(semanticEvidence) : unwiredL2();

    // L3：核对「声称完成」与「工具证据」是否一致。没有回答文本时如实报 unexec。
    const l3 = semanticEvidence
      ? adversarialClaimEvidence(evidence, semanticEvidence)
      : unwiredL3();

    const verdicts: CriterionVerdict[] = [...l0, canary.verdict, l2, l3];
    const summary = summarize(verdicts, profiles);

    // 复算所需的证据摘要：超限时只留 digest，但 digest 本身照样算全量，
    // 这样「证据漂移」还能被检测到。
    const evidenceDigest = evidenceDigestOf({
      toolCalls: evidence.toolCalls,
      approvals: evidence.approvals,
      semantic: semanticEvidence ? semanticDigestPart(semanticEvidence) : null,
    });

    const runId = this.repo.insertRun({
      sessionId,
      verdict: summary.verdict,
      score: summary.score,
      coverage: summary.coverage,
      executed: summary.executed,
      total: summary.total,
      // 快照压缩后再入库：证据原文不能砍（砍了 L2 就废），但也不能按原文存。
      contextJson: encodeSnapshot(
        this.buildContext(runtime, {
          profiles,
          summary,
          thresholds,
          canary,
          evidence,
          evidenceDigest,
          semantic: semanticEvidence,
        }),
      ),
    });
    this.repo.insertVerdicts(runId, sessionId, verdicts);

    return { sessionId, runId, ...summary, verdicts };
  }

  /**
   * 复算一次历史判决：用快照重跑判据塔，结论必须与当时一致。
   *
   * 只读：不写入任何行，因此可以无限次调用。DB 现况只用来标记证据漂移
   * （工具状态被后来的 UPDATE 改过之类），绝不参与 reproduced 判定。
   */
  replay(runId: number, source: ReplayEvidenceSource = 'snapshot'): JudgeReplayResult {
    const row = this.repo.getRun(runId);
    if (!row) {
      return {
        runId,
        outcome: 'unreproducible',
        reproduced: false,
        recorded: { verdict: 'inconclusive', coverage: 0, towerCoverage: 0, score: 0, coverageVersion: 1 },
        recomputed: null,
        diffs: [],
        evidence: { source, drifted: false, snapshotDigest: null, currentDigest: '' },
        judgeVersion: null,
        reasons: ['run_not_found'],
      };
    }
    const snapshot = parseContextSnapshot(row.context_json);
    const recordedVerdicts = this.repo.listVerdicts(runId);
    const currentDigest = this.currentEvidenceDigest(row.session_id, snapshot);
    return replayRun({
      runId,
      row,
      snapshot,
      recordedVerdicts,
      currentDigest,
      source,
      assessor: this.deps.semantic,
    });
  }

  /**
   * 事后深判：用 LLM 重判某次运行的 L2 语义层，并把结果作为**新的一行**追加。
   *
   * 与 `judge()` 的分工是刻意的：
   *  - `judge()` 在收尾同步跑，必须确定、便宜、绝不等网络；
   *  - `judgeDeep()` 事后按需跑，慢、花钱、非确定，因此它的结论**不覆盖原判决**，
   *    而是派生一条 `parent_run` 指向原行的子判决。原行永远是不可变的证据。
   *
   * 三个不可让步的性质：
   *  1. 只有 L2 换实现，L0/L1/L3 用**快照里的证据与阈值重跑**（与 replay 同一路径），
   *     这样深浅两档的 coverage/score 才是可比的；
   *  2. LLM 侧任何失败一律 `unexec`（绝不给 fail）——一次抽风不该写成「任务失败」；
   *  3. 凭据只在内存里，快照只留指纹。
   */
  async judgeDeep(runId: number, opts: JudgeDeepOptions = {}): Promise<JudgeDeepResult> {
    const base = {
      parentRun: runId,
      tier: 'deep' as const,
      reused: false,
      wroteRow: false,
      deep: null,
      reasons: [] as string[],
    };

    const row = this.repo.getRun(runId);
    if (!row) {
      return { ...base, status: 'unexec', runId: null, failure: 'run_not_found', reasons: ['run_not_found'] };
    }

    const snapshot = parseContextSnapshot(row.context_json);
    if (!snapshot || snapshot.coverageVersion !== COVERAGE_VERSION || !snapshot.semantic) {
      // v1 判决 / 无快照 / 规则层没留下语义证据：不是「失败」，是「不可深判」。
      return {
        ...base,
        status: 'unexec',
        runId: null,
        failure: 'original_not_eligible',
        reasons: ['original_not_eligible'],
      };
    }

    // 并发闸：同 run 互斥（避免同一次运行被判两遍）+ 全局上限（LLM 是花钱的外部依赖）。
    // 满了直接拒绝而不是排队——排队只会让多个请求一起撞超时。
    if (this.deepInFlight.has(runId)) {
      return { ...base, status: 'rejected', runId: null, rejected: 'in_flight' };
    }
    if (this.deepActive >= JudgeService.MAX_CONCURRENT_DEEP) {
      return { ...base, status: 'rejected', runId: null, rejected: 'busy' };
    }

    this.deepInFlight.add(runId);
    this.deepActive += 1;
    try {
      return await this.runDeep(runId, row, snapshot, opts);
    } catch (err) {
      // 深判是诊断能力：任何未预期异常都必须收成 unexec，不能 500，也不能半行写入。
      return {
        ...base,
        status: 'unexec',
        runId: null,
        failure: 'provider_error',
        reasons: [err instanceof Error ? err.message : String(err)],
      };
    } finally {
      this.deepInFlight.delete(runId);
      this.deepActive -= 1;
    }
  }

  private async runDeep(
    runId: number,
    row: JudgeRunRow,
    snapshot: JudgeRunContextSnapshot,
    opts: JudgeDeepOptions,
  ): Promise<JudgeDeepResult> {
    const base = { parentRun: runId, tier: 'deep' as const, reused: false, wroteRow: false };

    const semantic = snapshot.semantic;
    if (!semantic) {
      return { ...base, status: 'unexec', runId: null, deep: null, failure: 'original_not_eligible', reasons: ['original_not_eligible'] };
    }

    // 证据被截断时无法深判：用片段去评判会得到看似合法、实则无据的结论。
    const evidence = snapshot.evidence as JudgeEvidence & { truncated?: boolean };
    if (evidence.truncated) {
      return {
        ...base,
        status: 'unexec',
        runId: null,
        deep: null,
        failure: 'original_not_eligible',
        reason: 'evidence_truncated',
        reasons: ['evidence_truncated'],
      };
    }

    // ── 凭证：客户端优先，服务端兜底。二者都没有就是「没配」，不是「请求错」。 ──
    const clientKey = (opts.apiKey ?? '').trim();
    const serverKey = (this.deps.serverApiKey ?? '').trim();
    const apiKey = clientKey || serverKey;
    const keySource: DeepKeySource = clientKey ? 'client' : 'server';
    if (!apiKey) {
      return {
        ...base,
        status: 'unexec',
        runId: null,
        deep: null,
        failure: 'not_configured',
        reason: 'no_server_credential',
        reasons: ['no_server_credential'],
      };
    }

    // ── provider / model / baseUrl ──────────────────────────────────────────
    const session = this.deps.db.get<{ provider: string; model: string }>(
      `SELECT provider, model FROM sessions WHERE id = ?`,
      [row.session_id],
    );
    const providerId = (opts.provider ?? '').trim() || (session?.provider ?? '').trim();
    const model = (opts.model ?? '').trim() || (session?.model ?? '').trim();
    const modelSource: DeepModelSource = (opts.model ?? '').trim() ? 'request' : 'session';
    const baseUrl = (opts.baseUrl ?? '').trim() || (providerId ? resolveBaseUrl(providerId) : '');

    if (!providerId || !model) {
      return { ...base, status: 'unexec', runId: null, deep: null, failure: 'not_configured', reason: 'no_provider_or_model', reasons: ['no_provider_or_model'] };
    }
    if (!baseUrl) {
      // sessions 表不存 baseUrl，custom 会话事后必然拿不到地址 —— 这是常态不是异常。
      return { ...base, status: 'unexec', runId: null, deep: null, failure: 'not_configured', reason: 'custom_baseurl_unknown', reasons: ['custom_baseurl_unknown'] };
    }

    const fingerprint: DeepProviderFingerprint = {
      providerId,
      model,
      baseUrlHost: hostOf(baseUrl),
      keySource,
      modelSource,
    };

    // ── 幂等：同键成功过就直接复用，不再花钱 ────────────────────────────────
    if (!opts.force) {
      const reusableRunId = this.findReusableDeep(runId, providerId, model, keySource);
      if (reusableRunId !== null) {
        const existing = this.repo.getRun(reusableRunId);
        const existingSnapshot = parseContextSnapshot(existing?.context_json ?? null) as
          | (JudgeRunContextSnapshot & { deep?: { provider?: DeepProviderFingerprint } })
          | null;
        return {
          status: 'reused',
          parentRun: runId,
          runId: reusableRunId,
          reused: true,
          wroteRow: false,
          tier: 'deep',
          deep: {
            assessorId: DEEP_ASSESSOR_ID,
            model: existingSnapshot?.deep?.provider?.model ?? model,
            provider: existingSnapshot?.deep?.provider ?? fingerprint,
            promptTemplateVersion: 1,
            evidenceDigest: existingSnapshot?.evidenceDigest ?? '',
            usage: { promptTokens: 0, completionTokens: 0 },
            latencyMs: 0,
          },
          verdict: existing?.verdict,
          score: existing?.score,
          coverage: existing?.coverage,
          reasons: [],
          verdicts: this.repo.listVerdicts(reusableRunId).map((v) => ({
            layer: v.layer,
            criterion: v.criterion,
            status: v.status,
            ...(v.score === null ? {} : { score: v.score }),
            ...(v.detail === null ? {} : { detail: v.detail }),
          })),
        };
      }
    }

    // ── L0 / L1 / L3：用快照重跑，保证与 replay 同一条计算路径 ───────────────
    const thresholds = snapshot.thresholds ?? resolveThresholds(null);
    const canary = runCanary(thresholds, L0_CRITERIA, this.deps.semantic);
    const l0Trusted = canary.verdict.status === 'pass';
    const l0 = L0_CRITERIA.map((fn) => fn(evidence, thresholds)).map((v) =>
      l0Trusted
        ? v
        : {
            ...v,
            status: 'unexec' as const,
            detail: `L0 判据未通过金丝雀自证，本结论作废：${v.detail ?? ''}`.trim(),
          },
    );

    // ── L2：真·LLM 深判。超时是「本地计时器权威」，adapter 自带的 60s 太慢。 ──
    const timeoutMs = clampTimeout(opts.timeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    let outcome: DeepAssessOutcome;
    try {
      outcome = await assessDeep(semantic.evidence, {
        signal: controller.signal,
        model,
        provider: providerId,
        baseUrl,
        apiKey,
      });
    } finally {
      clearTimeout(timer);
    }

    // 超时的定性权归本地计时器，不归 adapter：它只会说「signal aborted」，
    // 分不清是我们叫停还是别的原因。而「超时」与「被中止」对复盘是两件事。
    if (timedOut && outcome.verdict.status === 'unexec') {
      outcome = {
        verdict: {
          layer: 'L2',
          criterion: DEEP_CRITERION,
          status: 'unexec',
          detail: `failure=timeout；深判超过 ${timeoutMs}ms 未返回，已中止`,
        },
        meta: { ...outcome.meta, failure: 'timeout' },
      };
    }

    // 深判行必须 fail-closed：L2 一旦可用就是必需层，否则 unexec 会被放过成 pass。
    const profiles: LayerProfile[] = (snapshot.profiles ?? DEFAULT_LAYER_PROFILES).map((p) =>
      p.layer === 'L2'
        ? {
            layer: 'L2' as const,
            available: true,
            required: true,
            reason: null,
            detail: `deep:${DEEP_ASSESSOR_ID}`,
          }
        : p,
    );

    // 深判行同样要跑 L3：一次「声称做了但其实没做」不会因为换了 L2 实现就消失。
    const verdicts: CriterionVerdict[] = [
      ...l0,
      canary.verdict,
      outcome.verdict,
      adversarialClaimEvidence(evidence, semantic.evidence),
    ];
    const summary = summarize(verdicts, profiles);

    const context = {
      ...snapshot.context,
      coverageVersion: COVERAGE_VERSION,
      judgeVersion: { rules: RULES_VERSION, coverage: COVERAGE_VERSION, assessor: DEEP_ASSESSOR_ID },
      profiles,
      unavailableLayers: summary.unavailableLayers,
      towerCoverage: summary.towerCoverage,
      towerExecuted: summary.towerExecuted,
      towerTotal: summary.towerTotal,
      layerCoverage: summary.layerCoverage,
      thresholds,
      context: snapshot.context,
      canary: { status: canary.verdict.status, goodScore: canary.goodScore, badScore: canary.badScore },
      evidence,
      // 这里必须写 DEEP_ASSESSOR_ID：replay 靠它识别「这是 LLM 判的、不可复算」，
      // 写成 rules.v1 会让 replay 用规则重算，碰巧同结论时会谎称 reproduced。
      semantic: { assessorId: DEEP_ASSESSOR_ID, evidence: semantic.evidence },
      evidenceDigest: snapshot.evidenceDigest,
      reasons: summary.reasons,
      requiredGaps: summary.requiredGaps,
      degraded: summary.degraded,
      parentRun: runId,
      deep: {
        assessorId: DEEP_ASSESSOR_ID,
        promptTemplateVersion: outcome.meta.promptTemplateVersion,
        provider: fingerprint,
        temperature: 0,
        usage: outcome.meta.usage,
        latencyMs: outcome.meta.latencyMs,
        failure: outcome.meta.failure ?? null,
        reason: outcome.meta.unknownReason ?? null,
        injectionSuspected: outcome.meta.injectionSuspected ?? false,
      },
    };

    // 一次事务写两处：run 行与 8 条判据要么一起进去，要么都不进去。
    const newRunId = this.deps.db.transaction(() => {
      const id = this.repo.insertRun({
        sessionId: row.session_id,
        verdict: summary.verdict,
        score: summary.score,
        coverage: summary.coverage,
        executed: summary.executed,
        total: summary.total,
        contextJson: encodeSnapshot(context),
        parentRun: runId,
      });
      this.repo.insertVerdicts(id, row.session_id, verdicts);
      return id;
    });

    return {
      status: outcome.verdict.status === 'unexec' ? 'unexec' : 'ok',
      parentRun: runId,
      runId: newRunId,
      reused: false,
      wroteRow: true,
      tier: 'deep',
      failure: outcome.meta.failure,
      deep: { ...outcome.meta, provider: fingerprint },
      verdict: summary.verdict,
      score: summary.score,
      coverage: summary.coverage,
      reasons: summary.reasons,
      verdicts,
    };
  }

  /**
   * 找可复用的深判行：同父行 + 同 assessor 版本 + 同 provider/model + 同凭证来源。
   * 凭证来源要进键：用别人的 key 与用服务端 key 得到的结果，不该互相顶替。
   */
  private findReusableDeep(
    runId: number,
    providerId: string,
    model: string,
    keySource: DeepKeySource,
  ): number | null {
    for (const candidate of this.repo.listDeepRuns(runId)) {
      const snap = parseContextSnapshot(candidate.context_json) as
        | (JudgeRunContextSnapshot & { deep?: { assessorId?: string; provider?: Partial<DeepProviderFingerprint> } })
        | null;
      const deep = snap?.deep;
      if (!deep?.assessorId || deep.assessorId !== DEEP_ASSESSOR_ID) continue;
      const fp = deep.provider;
      if (!fp) continue;
      if (fp.providerId !== providerId || fp.model !== model || fp.keySource !== keySource) continue;
      const l2 = this.repo.listVerdicts(candidate.id).find((v) => v.criterion === DEEP_CRITERION);
      // 只有「真的判出了结论」才算可复用；失败的行允许重试。
      if (l2 && l2.status !== 'unexec') return candidate.id;
    }
    return null;
  }

  /** 判据塔自证：金丝雀判别力 + 各判据历史分布 + 不可用层声明。 */
  selfCheck(): JudgeSelfCheck {
    const thresholds = resolveThresholds(this.thresholdsProvider?.() ?? null);
    const profiles = this.layerProfiles();
    return {
      canary: runCanary(thresholds, L0_CRITERIA, this.deps.semantic),
      thresholds,
      unimplementedLayers: profiles
        .filter((p) => !p.available)
        .map((p) => ({ layer: p.layer, reason: p.detail ?? p.reason ?? '未声明原因' })),
      profiles,
      criteria: this.repo.criterionStats(),
      totalRuns: this.repo.countRuns(),
    };
  }

  effectiveness(): LessonEffectiveness[] {
    return this.repo.lessonEffectiveness();
  }

  /**
   * 强化内核洞察视图（只读）。
   *
   * 三条禁令由结构保证，不靠自觉：
   *  - 不调 `judge()` / `judgeDeep()` / `replay()`，因此不可能触发判决或 LLM 调用；
   *  - 只走仓储的 `all/get` 读方法，路径上没有 `run/exec/transaction`；
   *  - 注入视图由调用方传入（来自 UpdateService），这里不碰 π 的 setter。
   *
   * 每块独立 try/catch：一块取不到就降级成空值并记进 `errors`，
   * 其余照常返回。洞察视图是排障工具，它自己不能成为新的故障点。
   */
  insight(opts: { limit: number; injection?: KernelInsight['injection'] }): KernelInsight {
    const limit = clampLimit(opts.limit);
    const errors: string[] = [];

    // ── 四层状态：复用 selfCheck 的 canary 与 profiles，不新造口径 ────────
    let selfCheck: ReturnType<JudgeService['selfCheck']> | null = null;
    try {
      selfCheck = this.selfCheck();
    } catch (err) {
      errors.push(`layers: ${err instanceof Error ? err.message : String(err)}`);
    }
    const profiles = this.layerProfiles();
    const unavailableLayers = selfCheck
      ? selfCheck.unimplementedLayers.map((l) => ({ layer: l.layer, reason: l.reason }))
      : [];

    // ── 最近一条规则判决的快照：用来取各层「上次实际覆盖率」──────────────
    let latestRulesSnapshot: JudgeRunContextSnapshot | null = null;
    try {
      const latest = this.repo.latestRulesRun();
      latestRulesSnapshot = latest ? parseContextSnapshot(latest.context_json) : null;
    } catch (err) {
      errors.push(`latestRules: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── 两档分布 ──────────────────────────────────────────────────────────
    let distribution: ReturnType<JudgeRepository['tierDistribution']> = {
      rules: { runs: 0, pass: 0, fail: 0, inconclusive: 0, lastRunId: null, lastCreatedAt: null },
      deep: {
        runs: 0,
        pass: 0,
        fail: 0,
        inconclusive: 0,
        lastRunId: null,
        lastCreatedAt: null,
        coveredOriginals: 0,
        repeatParents: 0,
      },
    };
    let runsScanned = 0;
    try {
      distribution = this.repo.tierDistribution(limit);
      runsScanned = distribution.rules.runs + distribution.deep.runs;
    } catch (err) {
      errors.push(`distribution: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── 深判花费：解压最近的深判快照累加（有界）──────────────────────────
    let deepRows: Array<{ id: number; snapshot: DeepSnapshot | null }> = [];
    try {
      deepRows = this.repo.recentDeepRuns(MAX_DEEP_USAGE_SCAN).map((row) => ({
        id: row.id,
        snapshot: parseContextSnapshot(row.context_json) as DeepSnapshot | null,
      }));
    } catch (err) {
      errors.push(`deepUsage: ${err instanceof Error ? err.message : String(err)}`);
    }

    let totalRuns = 0;
    try {
      totalRuns = this.repo.countRuns();
    } catch (err) {
      errors.push(`totalRuns: ${err instanceof Error ? err.message : String(err)}`);
    }

    return aggregateInsight({
      canary: selfCheck
        ? {
            status: selfCheck.canary.verdict.status,
            goodScore: selfCheck.canary.goodScore,
            badScore: selfCheck.canary.badScore,
            detail: selfCheck.canary.verdict.detail ?? '',
          }
        : { status: 'unexec', goodScore: 0, badScore: 0, detail: '自证状态不可用' },
      coverageThreshold: COVERAGE_THRESHOLD,
      profiles,
      unavailableLayers,
      latestRulesSnapshot,
      distribution,
      deepRows,
      limit,
      runsScanned,
      totalRuns,
      injection: opts.injection ?? null,
      errors,
    });
  }

  recordInjections(sessionId: string, policyVersion: number, lessons: string[]): number {
    return this.repo.recordInjections(sessionId, policyVersion, lessons);
  }

  /**
   * 组装可复算的判决快照。
   *
   * 顶层保留 runtime 平铺字段是为了兼容既有读取方（前端/历史测试直接读
   * ctx.finishReason）；结构化副本放进 context 子对象，避免「兼容」变成
   * 「字段含义看运气」。
   */
  private buildContext(
    runtime: JudgeRuntimeContext,
    input: {
      profiles: LayerProfile[];
      summary: JudgeSummary;
      thresholds: L0Thresholds;
      canary: CanaryOutcome;
      evidence: JudgeEvidence;
      evidenceDigest: string;
      semantic: SemanticEvidence | null;
    },
  ): JudgeRunContextSnapshot & JudgeRuntimeContext {
    const { profiles, summary, thresholds, canary, evidence, evidenceDigest, semantic } = input;
    const truncate =
      evidence.toolCalls.length > MAX_SNAPSHOT_TOOL_CALLS ||
      evidence.approvals.length > MAX_SNAPSHOT_APPROVALS;

    return {
      // ── 兼容旧读取方（历史测试与前端直接读顶层字段） ──────────────────
      ...runtime,
      // ── 复算快照（v2） ────────────────────────────────────────────────
      coverageVersion: COVERAGE_VERSION,
      judgeVersion: {
        rules: RULES_VERSION,
        coverage: COVERAGE_VERSION,
        assessor: this.deps.semantic?.id ?? null,
      },
      profiles,
      unavailableLayers: summary.unavailableLayers,
      towerCoverage: summary.towerCoverage,
      towerExecuted: summary.towerExecuted,
      towerTotal: summary.towerTotal,
      layerCoverage: summary.layerCoverage,
      thresholds,
      context: {
        finishReason: runtime.finishReason,
        iteration: runtime.iteration,
        tokenBudget: runtime.tokenBudget,
        usage: runtime.usage,
        circuitOpened: runtime.circuitOpened,
      },
      canary: {
        status: canary.verdict.status,
        goodScore: canary.goodScore,
        badScore: canary.badScore,
      },
      evidence: truncate
        ? {
            digest: evidenceDigest,
            truncated: true,
            counts: { toolCalls: evidence.toolCalls.length, approvals: evidence.approvals.length },
          }
        : evidence,
      semantic: semantic ? { assessorId: this.deps.semantic?.id ?? 'rules.v1', evidence: semantic } : null,
      evidenceDigest,
      reasons: summary.reasons,
      requiredGaps: summary.requiredGaps,
      degraded: summary.degraded,
    };
  }

  /** 从 τ 抽取判据所需的证据快照。只取判据用得到的字段，不搬整行。 */
  private collectEvidence(sessionId: string, runtime: JudgeRuntimeContext): JudgeEvidence {
    const toolCalls = this.evidenceToolCalls(sessionId);

    const approvals = this.deps.db.all<{ status: string; decision: string | null }>(
      `SELECT status, decision FROM approvals WHERE session_id = ?`,
      [sessionId],
    );

    return {
      sessionId,
      finishReason: runtime.finishReason,
      iteration: runtime.iteration,
      tokenBudget: runtime.tokenBudget,
      usage: runtime.usage,
      toolCalls,
      approvals,
      circuitOpened: runtime.circuitOpened,
    };
  }

  /**
   * tool_calls → 判据证据。额外并上命令执行的真实退出码。
   *
   * 为什么需要它：`sys.exec` 的 status=success 只表示「命令跑完了」，
   * 非 0 退出码（测试失败、类型报错）同样落 success。判据要判「做成了事」，
   * 就必须读退出码 —— 而退出码在 tool_results.inline_preview 的 JSON 里。
   * 只为 sys.exec 的行做这次 join，避免给判据路径引入全表解析开销。
   * 解析失败 / 预览被截断到没有 exitCode ⇒ 记 null（未知），判据回落到 status 口径。
   */
  private evidenceToolCalls(sessionId: string): JudgeEvidence['toolCalls'] {
    const exitCodes = this.deps.db.all<{ tool_call_id: string; inline_preview: string | null }>(
      `SELECT tr.tool_call_id AS tool_call_id, tr.inline_preview AS inline_preview
         FROM tool_calls tc
         JOIN tool_results tr ON tr.tool_call_id = tc.id
        WHERE tc.session_id = ? AND tc.tool_name = 'sys.exec'`,
      [sessionId],
    );
    const byToolCall = new Map<string, number | null>();
    for (const row of exitCodes) {
      const preview = row.inline_preview;
      if (!preview) {
        byToolCall.set(row.tool_call_id, null);
        continue;
      }
      try {
        const parsed = JSON.parse(preview) as { exitCode?: unknown };
        byToolCall.set(
          row.tool_call_id,
          typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
        );
      } catch {
        byToolCall.set(row.tool_call_id, null);
      }
    }

    return this.deps.toolCalls.listBySession(sessionId).map((t) => ({
      status: t.status as string,
      display_name: t.display_name,
      error_kind: t.error_kind,
      // 只有 sys.exec 行才有值。undefined 会被 canonicalJson 直接丢弃，
      // 因此**非 exec 会话的 evidence digest 必须保持字节级不变**（加了字段也不许漂移）。
      // 会变的只有含 exec 调用的会话：那是证据本身真的多了「真实退出码」，
      // 跨版本 replay 时显示一次 drift 是诚实反映，不是 bug。
      exit_code: byToolCall.get(t.id) ?? undefined,
    }));
  }

  /**
   * 从 messages + tool_calls 装配 L2 输入。
   *
   * goal 只取**最后一条**非摘要用户消息，不拼接历史：
   *  - 用户此刻要什么，最后一条说了算；历史诉求已被更近的诉求覆盖；
   *  - 拼接会让长会话的目标无限膨胀并最终超长，把整条语义判据拖成不可判
   *    （实测：十来轮对话就够 8000 字符）。
   */
  private collectSemanticEvidence(sessionId: string, evidence: JudgeEvidence): SemanticEvidence {
    const goal = this.deps.db.get<{ content: string }>(
      `SELECT content FROM messages
       WHERE session_id = ? AND role = 'user' AND is_summary = 0
       ORDER BY seq DESC LIMIT 1`,
      [sessionId],
    );
    const turns = this.deps.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'assistant'`,
      [sessionId],
    );
    const lastAssistant = this.deps.db.get<{ content: string }>(
      `SELECT content FROM messages
       WHERE session_id = ? AND role = 'assistant'
       ORDER BY seq DESC LIMIT 1`,
      [sessionId],
    );

    return buildSemanticEvidence({
      goal: goal?.content ?? '',
      finalAnswer: lastAssistant?.content ?? '',
      assistantTurns: turns?.n ?? 0,
      toolCalls: evidence.toolCalls,
      finishReason: evidence.finishReason,
    });
  }

  /**
   * DB 现况的 evidence digest。只用于「证据是否漂移」，
   * finishReason 这类运行期元数据不在 DB 里，沿用快照值（若没有则 unknown）。
   */
  private currentEvidenceDigest(sessionId: string, snapshot: JudgeRunContextSnapshot | null): string {
    // 必须与 collectEvidence 用同一份映射（含 exit_code），否则 exec 会话的
    // digest 会与快照恒不相等，被判成「证据漂移」的假红。
    const toolCalls = this.evidenceToolCalls(sessionId);
    const approvals = this.deps.db.all<{ status: string; decision: string | null }>(
      `SELECT status, decision FROM approvals WHERE session_id = ?`,
      [sessionId],
    );
    const finishReason = snapshot?.context?.finishReason ?? snapshot?.finishReason ?? 'unknown';
    const semantic = this.deps.semantic
      ? semanticDigestPart(
          this.collectSemanticEvidence(sessionId, {
            sessionId,
            finishReason,
            iteration: 0,
            tokenBudget: 0,
            usage: { promptTokens: 0, completionTokens: 0 },
            toolCalls,
            approvals,
            circuitOpened: false,
          }),
        )
      : null;
    return evidenceDigestOf({ toolCalls, approvals, semantic });
  }
}

// 兼容既有导入路径：定档逻辑住在 summarize.ts（judge 与 replay 共用同一份，
// 单独成文件是为了避开 JudgeService ↔ replay 的模块环）。
export { summarize, type SummarizeOptions } from './summarize.js';
