/**
 * Judge controller — 判据塔的只读视图。
 *
 * 暴露三件东西，都是「让内核可被看见」而非新增能力：
 *  - 判决历史：每次任务被怎么判、覆盖率多少；
 *  - 自证状态：判据塔此刻还有没有资格判决（金丝雀 + 未实现层声明）；
 *  - 经验有效性：注入过的 π 经验，事后任务表现如何。
 *
 * 一律只读：判决由运行时产生，不接受客户端写入 —— 否则「r 来自 Judge」
 * 这条约束就会被 HTTP 请求绕过。
 */

import type { Request, Response } from 'express';
import type { JudgeService } from '../services/judge/judge.service.js';
import { parseContextSnapshot, type JudgeRunContextSnapshot, type ReplayEvidenceSource } from '../services/judge/replay.js';
import { COVERAGE_THRESHOLD, type LayerProfile } from '../services/judge/types.js';
import type { KernelInsight } from '../services/judge/insight.js';
import type { UpdateService } from '../services/agent/update.service.js';

/** getRun 的 `?include=evidence` 才回原文；默认只回摘要。 */
const INCLUDE_EVIDENCE = 'evidence';

/** 洞察视图的默认窗口：与 JudgeService 里的 clamp 保持一致。 */
const DEFAULT_INSIGHT_LIMIT = 50;

export class JudgeController {
  /**
   * `policy` 是**可选**的第二个依赖：注入视图（本轮注入/裁掉了哪几条经验）住在
   * UpdateService 里，而它是 Update 的职责，不该塞进 JudgeService 再长出一条反向依赖
   * （Judge 与 Update 已有 thresholds 那条环）。
   *
   * 可选意味着 `new JudgeController(judge)` 的既有测试零改动，缺省时 `injection: null`。
   */
  constructor(
    private readonly judge: JudgeService,
    private readonly policy?: UpdateService,
  ) {}

  listRuns(req: Request, res: Response): void {
    const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId ? req.query.sessionId : undefined;
    const rawLimit = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 20;

    const runs = this.judge.repository.listRuns({ sessionId, limit });
    res.json({
      runs: runs.map((r) => {
        const snapshot = parseContextSnapshot(r.context_json);
        return {
          id: r.id,
          sessionId: r.session_id,
          verdict: r.verdict,
          score: r.score,
          coverage: r.coverage,
          executed: r.executed,
          total: r.total,
          // v1 行没有快照：如实报 1，不假装它也是 v2 口径。
          coverageVersion: snapshot?.coverageVersion ?? 1,
          towerCoverage: snapshot?.towerCoverage ?? r.coverage,
          degraded: snapshot?.degraded ?? false,
          unavailableLayers: snapshot?.unavailableLayers ?? [],
          reasons: runReasons(snapshot),
          // 判决分两档：规则层（parent_run 为空）与 LLM 深判（追加行）。
          // 前端必须能一眼分开，否则会把深判结论当成规则判定。
          tier: r.parent_run === null || r.parent_run === undefined ? 'rules' : 'deep',
          parentRun: r.parent_run ?? null,
          createdAt: r.created_at,
        };
      }),
    });
  }

  getRun(req: Request, res: Response): void {
    const id = parseRunId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: { code: 'INVALID_RUN_ID', message: 'run id 必须是正整数' } });
      return;
    }
    const run = this.judge.repository.getRun(id);
    if (!run) {
      res.status(404).json({ error: { code: 'JUDGE_RUN_NOT_FOUND', message: `判决 ${id} 不存在` } });
      return;
    }
    const snapshot = parseContextSnapshot(run.context_json);
    const verdicts = this.judge.repository.listVerdicts(id);
    const includeEvidence = req.query.include === INCLUDE_EVIDENCE;
    res.json({
      run: {
        id: run.id,
        sessionId: run.session_id,
        verdict: run.verdict,
        score: run.score,
        coverage: run.coverage,
        executed: run.executed,
        // total 是主口径（仅 available 层）；全塔条数以 towerTotal 为准。
        total: run.total,
        coverageVersion: snapshot?.coverageVersion ?? 1,
        towerCoverage: snapshot?.towerCoverage ?? run.coverage,
        towerExecuted: snapshot?.towerExecuted ?? null,
        towerTotal: snapshot?.towerTotal ?? null,
        layerCoverage: snapshot?.layerCoverage ?? null,
        degraded: snapshot?.degraded ?? false,
        unavailableLayers: snapshot?.unavailableLayers ?? [],
        reasons: runReasons(snapshot),
        tier: run.parent_run === null || run.parent_run === undefined ? 'rules' : 'deep',
        parentRun: run.parent_run ?? null,
        // 原判决上挂「已深判 → #57」、深判行上挂「深判自 #42」所需的两条指引。
        latestDeep: (() => {
          const deep = this.judge.repository.latestDeepRun(id);
          if (!deep) return null;
          const deepSnapshot = parseContextSnapshot(deep.context_json) as
            | { deep?: { provider?: { model?: string }; failure?: string | null } }
            | null;
          return {
            id: deep.id,
            verdict: deep.verdict,
            score: deep.score,
            coverage: deep.coverage,
            model: deepSnapshot?.deep?.provider?.model ?? null,
            failure: deepSnapshot?.deep?.failure ?? null,
            createdAt: deep.created_at,
          };
        })(),
        // 默认脱敏：证据原文（工具调用明细、goal/finalAnswer）不进默认响应。
        // 单条可达 50KB，且用户 prompt 原文没必要经这个接口二次暴露。
        context: includeEvidence ? snapshot : redactContext(snapshot),
        createdAt: run.created_at,
      },
      verdicts: verdicts.map((v) => ({
        id: v.id,
        layer: v.layer,
        criterion: v.criterion,
        status: v.status,
        score: v.score,
        detail: v.detail,
      })),
    });
  }

  /**
   * 判决复算（只读、幂等）。
   *
   * `unreproducible` 返 200 而不是错误码：它是一条**有效结论**
   * （「这份判决无法复算」），不是请求失败。用 4xx 表达会让前端无法区分
   * 「接口坏了」和「证据没存够」。
   */
  replay(req: Request, res: Response): void {
    const id = parseRunId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: { code: 'INVALID_RUN_ID', message: 'run id 必须是正整数' } });
      return;
    }
    if (!this.judge.repository.getRun(id)) {
      res.status(404).json({ error: { code: 'JUDGE_RUN_NOT_FOUND', message: `判决 ${id} 不存在` } });
      return;
    }
    const source: ReplayEvidenceSource = req.query.evidence === 'current' ? 'current' : 'snapshot';
    res.json(this.judge.replay(id, source));
  }

  selfCheck(_req: Request, res: Response): void {
    const report = this.judge.selfCheck();
    res.json({
      canary: {
        status: report.canary.verdict.status,
        detail: report.canary.verdict.detail,
        goodScore: report.canary.goodScore,
        badScore: report.canary.badScore,
        cases: report.canary.cases,
        semantic: report.canary.semantic,
      },
      thresholds: report.thresholds,
      // 覆盖率门槛下发给前端：前端不要在别处再硬编码一份 0.6。
      coverageThreshold: COVERAGE_THRESHOLD,
      unimplementedLayers: report.unimplementedLayers,
      profiles: report.profiles,
      degraded: report.profiles.some((p: LayerProfile) => !p.available),
      criteria: report.criteria,
      totalRuns: report.totalRuns,
    });
  }

  effectiveness(_req: Request, res: Response): void {
    res.json({ lessons: this.judge.effectiveness() });
  }

  /**
   * 强化内核洞察视图：一次拿全四项（四层状态 / 两档分布 / 深判花费 / 经验注入）。
   *
   * 三条禁令（由结构保证，不靠自觉）：
   *  1. 不调 judge/judgeDeep/replay —— 不能因为「想看深判结果」顺手判一条；
   *  2. 路径上没有 db.run/exec/transaction —— 只走仓储的 all/get；
   *  3. 不碰 π 的 setter —— 注入视图只读，记账只发生在 agent-loop 的真实注入点。
   *
   * 任何一块取不到都降级成空值（`injection: null`、`errors` 里记原因），
   * 不让洞察视图自己变成新的故障点。
   */
  insight(req: Request, res: Response): void {
    const rawLimit = Number(req.query.limit);
    // 只挡「不是数字」，越界交给 service 的 clampLimit 处理：
    // 这里再做一次 `> 0` 判断会把 `limit=0` 从「下界截断成 1」变成「回落默认 50」，
    // 两处各管一半就会出现两套边界语义。
    const limit = Number.isFinite(rawLimit) ? rawLimit : DEFAULT_INSIGHT_LIMIT;

    let injection: KernelInsight['injection'] = null;
    if (this.policy) {
      try {
        const view = this.policy.getInjectableView();
        const budget = this.policy.getInjectionBudget();
        injection = {
          version: view.version,
          lessons: view.lessons,
          evicted: view.evicted,
          chars: view.chars,
          policyLessons: view.policy.lessons.length,
          budget: { maxLessons: budget.maxLessons, maxChars: budget.maxChars },
        };
      } catch {
        injection = null;
      }
    }

    res.json(this.judge.insight({ limit, injection }));
  }

  /**
   * 事后深判：用 LLM 重判某次运行的 L2 语义层。
   *
   * 这是系统里**第一个写判决的端点**，所以三条边界必须显式：
   *  - 不接受任意上游代理：credential 只用于这一次调用，不落库不落日志；
   *  - 三种终局（ok / unexec / reused）都返 200 —— unexec 是有效结论，不是请求失败，
   *    与 replay 把 unreproducible 也返 200 的先例一致；
   *  - 被并发闸挡下才返 409/429，因为那确实需要客户端改行为。
   */
  async deepJudge(req: Request, res: Response): Promise<void> {
    const id = parseRunId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: { code: 'INVALID_RUN_ID', message: 'run id 必须是正整数' } });
      return;
    }
    const run = this.judge.repository.getRun(id);
    if (!run) {
      res.status(404).json({ error: { code: 'JUDGE_RUN_NOT_FOUND', message: `判决 ${id} 不存在` } });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const credentials = (body.credentials ?? null) as { apiKey?: unknown; baseUrl?: unknown } | null;

    // 默认允许客户端凭证（与 /agent/stream 的既有行为一致：前端填了 key 就该能用）；
    // 运维可用 JUDGE_DEEP_ALLOW_CLIENT_KEY=0 收紧成「只认服务端 key」。
    // 必须在调用时读 env：模块加载时快照会让这个开关在测试与热更下失效。
    const allowClientKey = process.env.JUDGE_DEEP_ALLOW_CLIENT_KEY !== '0';
    if (!allowClientKey && credentials) {
      res.status(400).json({
        error: {
          code: 'JUDGE_DEEP_CLIENT_KEY_NOT_ALLOWED',
          message: '服务端已禁用客户端凭证，深判只能使用服务端配置的 key',
        },
      });
      return;
    }

    const clientKey = typeof credentials?.apiKey === 'string' ? credentials.apiKey.trim() : '';
    const result = await this.judge.judgeDeep(id, {
      provider: asString(body.provider),
      model: asString(body.model),
      baseUrl: asString(body.baseUrl) || asString(credentials?.baseUrl),
      apiKey: clientKey || undefined,
      force: body.force === true,
      timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
    });

    if (result.status === 'rejected') {
      if (result.rejected === 'in_flight') {
        res.status(409).json({ error: { code: 'JUDGE_DEEP_IN_FLIGHT', message: '同一判决已有深判在执行' } });
        return;
      }
      res.status(429).json({ error: { code: 'JUDGE_DEEP_BUSY', message: '深判并发已满，请稍后重试' } });
      return;
    }

    // 显式构造响应体，不用展开：meta 里的 rawResponse 可能含模型原文，没必要回传；
    // 更重要的是这样能保证「凭证永远不会顺着某个 ...spread 漏出去」。
    res.status(200).json({
      status: result.status,
      parentRun: result.parentRun,
      runId: result.runId,
      reused: result.reused,
      wroteRow: result.wroteRow,
      tier: result.tier,
      failure: result.failure ?? null,
      reason: result.reason ?? null,
      deep: result.deep
        ? {
            assessorId: result.deep.assessorId,
            promptTemplateVersion: result.deep.promptTemplateVersion,
            provider: result.deep.provider,
            temperature: 0,
            usage: result.deep.usage,
            latencyMs: result.deep.latencyMs,
            failure: result.deep.failure ?? null,
            reason: result.deep.unknownReason ?? null,
            injectionSuspected: result.deep.injectionSuspected ?? false,
          }
        : null,
      verdict: result.verdict ?? null,
      score: result.score ?? null,
      coverage: result.coverage ?? null,
      reasons: result.reasons,
      verdicts: result.verdicts ?? [],
    });
  }
}

/** run id 只接受正整数：'1.5' / '-3' / 'abc' 都是客户端错误，不该落到 SQL 里。 */
function parseRunId(raw: unknown): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

/** 快照里没有 reasons（v1 行）时给空数组，不编造定档理由。 */
function runReasons(snapshot: JudgeRunContextSnapshot | null): string[] {
  const reasons = (snapshot as { reasons?: unknown } | null)?.reasons;
  return Array.isArray(reasons) ? (reasons as string[]) : [];
}

/**
 * 把快照里的**证据原文**替换为摘要。
 *
 * 保留判定所需的一切元信息（谁、多少、哪种终止原因），只去掉正文：
 * 工具调用的 display_name 明细与 goal/finalAnswer 原文。
 * 需要原文的排障场景显式走 `?include=evidence`，别让它成为默认响应体积。
 */
function redactContext(snapshot: JudgeRunContextSnapshot | null): unknown {
  if (!snapshot) return null;
  const evidence = snapshot.evidence as
    | { toolCalls?: unknown[]; approvals?: unknown[]; digest?: string; truncated?: boolean }
    | undefined;
  const semantic = snapshot.semantic;
  return {
    ...snapshot,
    evidence: {
      digest: evidence?.digest ?? snapshot.evidenceDigest,
      toolCallCount: Array.isArray(evidence?.toolCalls) ? evidence.toolCalls.length : null,
      approvalCount: Array.isArray(evidence?.approvals) ? evidence.approvals.length : null,
      truncated: evidence?.truncated === true,
    },
    semantic: semantic
      ? {
          assessorId: semantic.assessorId,
          goalChars: semantic.evidence.charCount?.goal ?? semantic.evidence.goal.length,
          answerChars: semantic.evidence.charCount?.finalAnswer ?? semantic.evidence.finalAnswer.length,
          assistantTurns: semantic.evidence.assistantTurns,
          toolSummary: semantic.evidence.toolSummary,
          finishReason: semantic.evidence.finishReason,
        }
      : null,
  };
}

/** 只接受非空字符串：Number/null/对象一律当「未提供」，避免 `1` 被当成 model 名。 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
