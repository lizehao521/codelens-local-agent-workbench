/**
 * Agent loop (AC-02 / architecture 4.4): the explicit state machine driving
 * channel turns → tool resolution → gated execution → observation feedback,
 * under the T-1..T-5 termination conditions, budget, circuit breaker and loop
 * detector. Long-lived deps are injected once; per-request services (approvals,
 * executor, context manager) are built inside run() because they hold the SSE
 * stream of that request.
 */

import type { SessionRepository, SessionRow } from '../memory/session.repository.js';
import type { MessageRepository } from '../memory/message.repository.js';
import type { ToolCallRepository, ToolCallRow } from '../memory/tool-call.repository.js';
import type { ToolResultRepository } from '../memory/tool-result.repository.js';
import type { ApprovalRepository } from '../memory/approval.repository.js';
import type { ProviderCapabilityRepository } from '../memory/provider-capability.repository.js';
import type { OpenAICompatibleAdapter } from '../../providers/openai-compatible.adapter.js';
import type { ToolRegistry } from '../tools/registry.service.js';
import { ToolExecutor } from '../tools/executor.service.js';
import type { ToolDefinition } from '../../types/tool.js';
import type { AgentFinishReason } from '../../types/agent-events.js';
import type { Usage } from '../../types/index.js';
import { ApprovalService } from './approval.service.js';
import { ApprovalDedupService } from './approval-dedup.service.js';
import { AbortRegistry } from './abort-registry.js';
import { CallResolver } from './call-resolver.js';
import { ChannelRouter, type Channel } from './channel-router.service.js';
import { adaptOutputBudget } from './output-budget.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { ContextManager } from './context-manager.service.js';
import { LoopDetector } from './loop-detector.js';
import { ConvergenceDetector, buildRoundSignature } from './convergence-detector.js';
import {
  canRetry,
  checkTermination,
  consumeRetry,
  createBudget,
  deriveTokenBudget,
  type BudgetState,
} from './loop-budget.js';
import { runNativeTurn } from './native-channel.js';
import { renderToolCatalogue, runReactTurn } from './react-channel.js';
import type { TurnIR } from './turn-ir.js';
import { SseWriter } from './sse-writer.js';
import { RunCancellation, describeCancel } from './run-cancel.js';
import { buildSystemPrompt, buildRuntimeSections } from './system-prompt.js';
import type { TaskKind } from './task-prompts.js';
import { config } from '../../config/env.js';
import { buildReverseIndex } from '../../utils/tool-name.js';
import { argsDigest } from '../../utils/digest.js';
import { estimateAssistantTokens, estimateTextTokens } from './token-estimator.js';
import { runGateway } from '../tools/security-gateway.js';
import { FallbackBudgetService } from './fallback-budget.service.js';
import type { UpdateService } from './update.service.js';
import type { JudgeService } from '../judge/judge.service.js';
import type { SandboxPermissionService } from '../tools/sandbox-permission.service.js';
import type { TraceService, TraceSpanKind } from '../observability/trace.service.js';
import type { CheckpointService } from '../tx/checkpoint.service.js';
import type { SandboxGrantService } from '../tools/sandbox-grant.service.js';
import type { ReviewService } from './review.service.js';
import type { ReviewContext } from './review.service.js';
import { buildReviewFacts } from './review-facts.js';
import { prepareRun } from './run-assembly.js';
import type { RunStateService } from './run-state.service.js';
import type { ReviewFacts } from '../../types/tool.js';

export interface AgentRunRequest {
  sessionId?: string;
  provider: string;
  model: string;
  apiKey?: string;
  /** 客户端来源 IP（兜底 Key 试用/预算闸键）；由 controller 注入 req.ip。 */
  clientIp?: string;
  /** 自定义 Provider（provider='custom'）的 Base URL，随请求透传给 providerBaseUrl。 */
  customBaseUrl?: string;
  message: string;
  /** 四类任务模式：合成进两通道的 system prompt（缺省 = 自由对话）。 */
  taskKind?: TaskKind;
  tools?: string[];
  channelMode: 'auto' | 'native' | 'react';
  /** 是否计入 RSI 测量（缺省 true）。false = 只干活/学习，不参与跨代对账。 */
  rsiMeasure?: boolean;
  /** 测量采样次数（缺省 1）。>1 时 RSI 读数取最近 N 次同探针判决的均值。 */
  rsiMeasureSamples?: number;
  maxIterations: number;
  temperature: number;
  maxTokens: number;
  resumeFromCallId?: string;
  overrideArguments?: Record<string, unknown>;
}

export interface AgentLoopDeps {
  sessions: SessionRepository;
  messages: MessageRepository;
  toolCalls: ToolCallRepository;
  toolResults: ToolResultRepository;
  approvals: ApprovalRepository;
  approvalService: ApprovalService;
  capabilities: ProviderCapabilityRepository;
  registry: ToolRegistry;
  adapter: OpenAICompatibleAdapter;
  abortRegistry: AbortRegistry;
  sandboxRoot: string;
  providerBaseUrl: (provider: string, customBaseUrl?: string) => string;
  serverApiKey: string;
  fallbackBudget: FallbackBudgetService;
  /**
   * 试用锁定（可选）：未自带 BYOK Key 的请求固定走服务端指定的上游与模型。
   * 不提供时保持历史行为（用请求里的 provider/model + 兜底 Key）。
   */
  trialLock?: TrialLock | null;
  /**
   * 强化内核 Update 闭环（可选）。提供时：
   *  - 每轮 Act 的 system prompt 会注入当前 π'（上一轮沉积的经验）；
   *  - 任务结束时，若工具执行有纠正性失败，会把一条经验沉积进 π。
   * 不提供时退化为历史行为（零影响，向后兼容）。
   */
  policy?: UpdateService;
  /**
   * 判据塔（可选）。提供时，任务结束会先由 Judge 作出结构化判决 r，
   * 再由 Update 消费 r 生成经验（r 必须来自 Judge，不能来自「看起来不错」）。
   * 不提供时退化为按工具失败计数沉积经验的历史行为。
   */
  judge?: JudgeService;
  /**
   * RSI 跨代对账（可选，L1 机械桥）。提供时，任务收尾会在 Judge 判决 + Update 写 π 之后，
   * 再走一次 RSI bridge：把当前 run 的 verdicts 转成 RSI Manifest，查上一代 manifest，
   * 调 krsi CLI 做四态对比。
   *
   * 双轨并存：RSI verdict **不**阻断现有闭环，UpdateService 照常写 π 增量。
   * RSI 只落 policy_rsi_runs 审计表供事后复盘。
   *
   * 不提供时完全跳过（零影响，向后兼容）。
   */
  rsi?: import('../rsi/rsi-bridge.service.js').RsiBridgeService;
  /**
   * SQLite 句柄（可选）。RSI 归因器直接向 policy_injections 落审计行，
   * 需要它才能工作。不传时归因整段跳过 —— 表现为「对账有结果、但没有经验沉淀」。
   */
  db?: import('../../repositories/db.js').Db;
  /**
   * RSI 归因器 LLM 凭证（可选）。提供时：krsi 判 not_improved / refused 后，
   * 会调 LLM 归因并把归因经验写回 policy_injections 作为 π'。
   * 不提供时跳过归因，RSI 只有旁路对账（零影响，向后兼容）。
   */
  rsiAttributorApiKey?: string;
  rsiAttributorBaseUrl?: string;
  rsiAttributorModel?: string;
  /**
   * 沙箱权限服务（可选）：提供 allowDirs（沙箱外白名单）与 autoApprove（审批豁免）。
   * 提供时，运行时 gateway / executor 实时读取最新配置（PUT 后立即生效，无需重启）。
   * 不提供时退化为历史行为（无白名单、审批条照常弹出），向后兼容。
   */
  sandboxPermissions?: SandboxPermissionService;
  /**
   * 运行轨迹（可选，观测面）。提供时，一次 run 会记一条 trace，
   * 其下按序记录 act（工具动作）/ judge（判决）/ update（策略更新）三类 span。
   *
   * 不提供时不做任何埋点，行为与历史一致（向后兼容）。
   */
  trace?: TraceService;
  /**
   * 服务关闭信号（可选）。提供时，SIGTERM/SIGINT → runtime.close() 会取消所有在途 run，
   * 而不是等上游超时或工具跑完。
   */
  shutdownSignal?: AbortSignal;
  /**
   * 工作区快照（可选）。提供时，每轮文件修改前自动捕获「本轮将改动的文件」，
   * 出问题可按快照 id 回滚；捕获失败只告警，不阻断任务。
   * 不提供时不捕获，行为与历史一致（向后兼容）。
   */
  checkpoint?: CheckpointService;
  /**
   * 目录授权（可选）：工作区外首次访问弹一次授权，放行后并入 allowedDirs。
   * 不提供时保持历史行为（越界访问直接拒绝，不弹授权）。
   */
  grants?: SandboxGrantService;
  /**
   * 独立复核（可选）：不可逆调用在执行前同步等结论，可逆调用在执行后并行回填。
   * 不提供时跳过复核（零影响）。
   */
  review?: ReviewService;
  /**
   * RunState（可选）：结构化记录 run 的阶段/工具/审批/文件改动/成本，
   * 收尾生成汇报卡。不提供时不记录，行为与历史一致。
   */
  runState?: RunStateService;
}

export interface TrialLock {
  provider: string;
  model: string;
  baseUrl?: string;
}

/**
 * 本轮真正使用的上游三元组。
 *
 * 三条规则（顺序即优先级）：
 * 1. 自带 BYOK Key 的请求永不被锁 —— 用户自己选的上游优先级最高；
 * 2. 无 Key 且服务端配了兜底 Key（fallback）+ 锁定项存在 → 强制覆盖 provider/model；
 * 3. 锁定项没配 baseUrl 时保留请求里的 customBaseUrl（不误伤自带端点 + 自带 Key 的场景）。
 *
 * 导出为纯函数：无需跑整条 agent 循环即可单测「锁没锁对」，避免回归。
 */
export function resolveTrialTarget<
  T extends { provider: string; model: string; customBaseUrl?: string },
>(
  req: T,
  isFallback: boolean,
  lock: TrialLock | null | undefined,
): { provider: string; model: string; customBaseUrl: string | undefined } {
  if (!isFallback || !lock) {
    return { provider: req.provider, model: req.model, customBaseUrl: req.customBaseUrl };
  }
  return {
    provider: lock.provider,
    model: lock.model,
    // 兜底用的是服务端 Key，因此 Base URL 必须完全由服务端锁定项决定：
    // 绝不把请求里用户自带的 customBaseUrl 与服务端 Key 组合使用，否则等于把 Key 发往任意地址。
    customBaseUrl: lock.baseUrl,
  };
}

/**
 * 从本轮工具调用里挑出「本轮将被改动的文件」路径，作为快照白名单。
 *
 * 两条取舍：
 * 1. 只认 `fs.write`。`fs.read` / `fs.list` 同属 file 分类但不改文件，
 *    给它们拍快照只会产出无意义的 IO 与记录。
 * 2. 猜不出路径时宁可不拍。漏拍的代价只是少一个回滚点；错拍（拍了一堆无关文件）
 *    则会浪费 IO 并让用户误以为「这些文件都在快照里」。
 *
 * rename 要同时算 `path` 与 `newPath`：目标若已存在会被覆盖，必须一起拍。
 *
 * 导出为模块级纯函数而不是私有方法：它是纯计算（无 IO、无状态），
 * 导出后可直接被单测覆盖 —— 而私有方法只能靠跑整条 agent 循环才能碰到。
 */
export function selectFilesToSnapshot(
  items: Array<{ toolCall: { tool_name: string }; args: Record<string, unknown> }>,
): string[] {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.toolCall.tool_name !== 'fs.write') continue;
    if (typeof item.args?.operation !== 'string') continue;
    for (const key of ['path', 'newPath'] as const) {
      const value = item.args?.[key];
      if (typeof value === 'string' && value.trim().length > 0) paths.add(value.trim());
    }
  }
  return [...paths];
}

/**
 * 本轮「新建文件」候选：`fs.write` 且 `operation=create` 的 path。
 *
 * 单独挑出来的原因：新建文件在**执行前不存在**，`capture` 拿不到正文，
 * 白名单模式下不会落记录；执行后需要用这份清单补一条 create 记录，
 * 否则新文件在审计 / 续跑校验 / 撤销里全部隐形。
 */
export function selectCreatedFiles(
  items: Array<{ toolCall: { tool_name: string }; args: Record<string, unknown> }>,
): string[] {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.toolCall.tool_name !== 'fs.write') continue;
    if (item.args?.operation !== 'create') continue;
    const value = item.args?.path;
    if (typeof value === 'string' && value.trim().length > 0) paths.add(value.trim());
  }
  return [...paths];
}

export class AgentLoopService {
  readonly approvalService: ApprovalService;
  private readonly channelRouter: ChannelRouter;
  /**
   * 每个进行中 run 的轨迹 id，**按会话隔离**。
   *
   * 为什么不用实例字段「当前 trace」：agent-loop 是单实例多会话并发服务
   * （AGENT_MAX_CONCURRENT 默认 3），实例字段会被并发的另一个 run 覆盖，
   * 于是 A 会话的 span 会被记到 B 的轨迹上。按 session.id 存则互不干扰，
   * 且 run 的所有出口都经过 finally，清理是有保证的。
   */
  private readonly activeTraces = new Map<string, string>();
  /**
   * 本次 run 是否**不**计入 RSI 测量（rsiMeasure=false 的"干活轮"）。
   * 按 sessionId 记录，finish 时清除 —— 干活轮照常判决与学习，只是不进跨代对账。
   */
  private readonly nonMeasureSessions = new Set<string>();
  /**
   * 测量采样次数（按 sessionId）。测量轮由请求带入；finish 时清除。
   * 只在 rsiMeasure=true 的 run 上生效，交给 RsiBridgeService 做多样本均值。
   */
  private readonly measureSampleCounts = new Map<string, number>();
  /** 汇报卡每个 run 只发一次（finish 可能被多个出口调用）。 */
  private readonly reportedRuns = new Set<string>();

  constructor(private readonly deps: AgentLoopDeps) {
    this.approvalService = deps.approvalService;
    this.channelRouter = new ChannelRouter(deps.adapter, deps.capabilities);
  }

  /** The router is shared so the sessions controller can trigger model-switch probes. */
  router(): ChannelRouter {
    return this.channelRouter;
  }

  /**
   * 会话/预算/轨迹/RunState 的前置装配。失败时已通过 SSE 报错，调用方直接 return。
   */
  private async prepareSession(p: { req: AgentRunRequest; sse: SseWriter; signal: AbortSignal }): Promise<
    | {
        runId: string; apiKey: string; clientIp: string; isFallback: boolean;
        session: SessionRow; budget: BudgetState; usage: Usage;
        onFirstToken: (kind: 'reasoning' | 'content') => void;
        firstTokenMs: () => number | null;
        cancel: RunCancellation; turnSignal: AbortSignal; traceId: string | null;
      }
    | null
  > {
    const { req, sse, signal } = p;
    const runId = sse.beginRunStage();
    sse.emitStage('connecting');
    const apiKey = req.apiKey?.trim() || this.deps.serverApiKey;
    if (!apiKey) {
      sse.emit('error', { code: 'MISSING_API_KEY', message: '未配置 API Key，请在设置页填写', retryable: false });
      return null;
    }

    const clientIp = req.clientIp ?? 'unknown';
    const isFallback = !req.apiKey?.trim() && this.deps.serverApiKey.length > 0;
    const target = resolveTrialTarget(req, isFallback, this.deps.trialLock);
    req.provider = target.provider;
    req.model = target.model;
    req.customBaseUrl = target.customBaseUrl;

    if (isFallback && this.deps.fallbackBudget) {
      const gate = this.deps.fallbackBudget.reserve(clientIp);
      if (!gate.ok) {
        sse.emit('error', {
          code: 'BUDGET_EXCEEDED',
          message: gate.message ?? '兜底 Key 额度已用尽，请配置自己的 API Key',
          retryable: false,
        });
        return null;
      }
    }

    const usage = { promptTokens: 0, completionTokens: 0 };
    const runStartedAt = Date.now();
    let firstTokenAt: number | null = null;
    const onFirstToken = (kind: 'reasoning' | 'content'): void => {
      if (firstTokenAt === null) firstTokenAt = Date.now();
      sse.emitStage(kind);
      this.deps.runState?.stage(runId, kind);
    };
    const firstTokenMs = (): number | null => (firstTokenAt !== null ? firstTokenAt - runStartedAt : null);

    let session: SessionRow | undefined;
    if (req.sessionId) session = this.deps.sessions.get(req.sessionId);
    else session = this.deps.sessions.create({ provider: req.provider, model: req.model });
    if (!session) {
      sse.emit('error', { code: 'SESSION_NOT_FOUND', message: '会话不存在或已被删除', retryable: false });
      return null;
    }

    this.deps.runState?.start({
      runId,
      sessionId: session.id,
      provider: req.provider,
      model: req.model,
      channel: req.channelMode,
    });
    if (req.rsiMeasure === false) {
      this.nonMeasureSessions.add(session.id);
      this.measureSampleCounts.delete(session.id);
    } else {
      this.nonMeasureSessions.delete(session.id);
      this.measureSampleCounts.set(session.id, Math.max(1, req.rsiMeasureSamples ?? 1));
    }
    this.deps.runState?.stage(runId, 'connecting');

    const traceId = this.deps.trace?.startTrace(session.id, `run:${req.provider}/${req.model}`)?.traceId ?? null;
    if (traceId) this.activeTraces.set(session.id, traceId);

    if (this.deps.abortRegistry.isActive(session.id)) {
      await this.deps.abortRegistry.abortAndWait(session.id);
    }
    const registryController = this.deps.abortRegistry.register(session.id);
    const cancel = new RunCancellation()
      .link(registryController.signal, 'abort')
      .link(signal, 'abort')
      .link(this.deps.shutdownSignal, 'shutdown');
    const turnSignal = cancel.signal;
    const budget: BudgetState = createBudget({
      maxIterations: req.maxIterations,
      maxToolCalls: config.agentMaxToolCalls,
      totalBudgetMs: config.agentTaskBudgetMs,
    });

    return { runId, apiKey, clientIp, isFallback, session, budget, usage, onFirstToken, firstTokenMs, cancel, turnSignal, traceId };
  }

  async run(req: AgentRunRequest, sse: SseWriter, signal: AbortSignal): Promise<void> {
    // R3：controller 已在最前面发过 connecting（幂等）；这里兜底保证直接调用方也有 run 标识。
    const prep = await this.prepareSession({ req, sse, signal });
    if (!prep) return;
    const { runId, apiKey, clientIp, isFallback, session, budget, usage, firstTokenMs, onFirstToken, cancel, turnSignal, traceId } = prep;
    let traceStatus: 'ok' | 'error' = 'ok';
    try {
      // 复核上下文：与主脑同一上游，但输入只有事实（ReviewFacts 类型层面隔离）。
      const reviewCtx = {
        runId,
        sessionId: session.id,
        provider: req.provider,
        model: req.model,
        apiKey,
        baseUrl: this.deps.providerBaseUrl(req.provider, req.customBaseUrl),
      };
      const review = this.deps.review;
      const { executor, contextManager, breaker, detector, convergence, reportedCircuit, resolver } = prepareRun(
        {
          toolCalls: this.deps.toolCalls, toolResults: this.deps.toolResults, registry: this.deps.registry,
          messages: this.deps.messages, adapter: this.deps.adapter, sandboxRoot: this.deps.sandboxRoot,
          sandboxPermissions: this.deps.sandboxPermissions, checkpoint: this.deps.checkpoint,
          grants: this.deps.grants, runState: this.deps.runState, review,
        },
        {
          approvals: this.approvalService, channelRouter: this.channelRouter, sse, req, budget, runId,
          turnSignal, reviewCtx, baseUrl: reviewCtx.baseUrl, apiKey,
          allowedDirs: this.deps.sandboxPermissions?.allowDirs ?? [], sessionId: session.id,
        },
      );

      const onAbort = (): void => {
        budget.aborted = true;
        this.approvalService.abortSession(session!.id);
        this.deps.grants?.abortSession(session!.id);
      };
      // 取消上下文是唯一权威来源：无论 abort 来自断连、POST 还是服务关闭，
      // 都走这里收尾（含唤醒被审批挂起的执行器）。
      cancel.signal.addEventListener('abort', onAbort, { once: true });
      if (cancel.signal.aborted) onAbort();
      // 请求级断连还要同步到 registry，避免稍后的 POST /agent/abort 对一个
      // 已经不在的 run 返回 aborted=true（状态自相矛盾）。
      signal.addEventListener('abort', () => this.deps.abortRegistry.abort(session!.id), { once: true });

      /** 统一的中止收尾：不把用户中止（或服务关闭）当成上游错误上报。 */
      const finishCancelled = (): void => {
        const detail = describeCancel(cancel.reason);
        sse.emitStage('aborted', detail);
        this.finish(sse, session, 'aborted', budget.iteration, usage, detail, undefined, budget.tokenBudget, firstTokenMs());
      };

      // ── AC-10 resume: rewind + re-execute one step ───────────────────────────
      if (req.resumeFromCallId) {
        const target = this.deps.toolCalls
          .listBySession(session.id)
          .find((row) => row.call_id === req.resumeFromCallId);
        if (target) {
          this.deps.toolCalls.markSkippedFrom(target.id);
          this.deps.messages.deleteAfter(session.id, target.message_id);
          await this.reExecuteStep(req, target, executor, turnSignal);
          budget.iteration = target.iteration;
        }
      }

      // ── user message ─────────────────────────────────────────────────────────
      const userMsg = this.deps.messages.insert({
        sessionId: session.id,
        role: 'user',
        content: req.message,
        tokens: estimateTextTokens(req.message),
      });
      this.deps.sessions.bumpCounters(session.id, 1, userMsg.tokens);

      // ── channel decision + first meta ────────────────────────────────────────
      // 能力探测必须吃 run 级 signal：等待首事件期间中止时，探测请求随之中止，
      // 而不是跑完 4,982 ms 再写回能力表（R5 实测）。
      let decision: Awaited<ReturnType<ChannelRouter['decide']>>;
      try {
        decision = await this.channelRouter.decide(
          req.channelMode,
          req.provider,
          req.model,
          apiKey,
          this.deps.providerBaseUrl(req.provider, req.customBaseUrl),
          turnSignal,
        );
      } catch (err) {
        // 探测阶段的取消不应冒泡成 INTERNAL_ERROR（用户自己点的停止不是错误）。
        if (cancel.cancelled) {
          finishCancelled();
          return;
        }
        throw err;
      }
      if (cancel.cancelled) {
        finishCancelled();
        return;
      }
      let channel: Channel = decision.channel;
      let degraded = decision.degraded;
      let degradedReason = decision.degradedReason;
      const toolDefs = this.selectTools(req.tools);
      // AUDIT-028：任务累计 token 硬顶 = 上下文窗口推导（防止失控跑满）。
      budget.tokenBudget = deriveTokenBudget(decision.capabilities.contextWindow, config.agentTokenBudgetFactor);
      // A-01：兜底 Key 单任务 token 预算覆盖软闸（仅 fallback 请求，0 = 沿用软闸）。
      if (isFallback && this.deps.fallbackBudget.perTaskTokenLimit > 0) {
        budget.tokenBudget = Math.min(budget.tokenBudget, this.deps.fallbackBudget.perTaskTokenLimit);
      }

      const emitMeta = (iteration: number, switchedFrom: string | null, switchReason: string | null): void => {
        sse.emit('meta', {
          sessionId: session!.id,
          messageId: userMsg.id,
          provider: req.provider,
          model: req.model,
          channel,
          degraded,
          degradedReason,
          iteration,
          maxIterations: req.maxIterations,
          contextWindow: decision.capabilities.contextWindow,
          tokenBudget: budget.tokenBudget,
          estimatedPromptTokens: usage.promptTokens,
          toolCount: toolDefs.length,
          switchedFrom,
          switchReason,
        });
      };
      emitMeta(budget.iteration + 1, null, null);

      // ── π 注入视图：run 级求值，一次 ─────────────────────────────────────────
      //
      // 这里是**唯一求值点**，且在 turn loop 之外。两个理由，缺一不可：
      //
      // 1. 语义：经验集合是**这次 run 的输入**，不是每轮 turn 的输入。若中途
      //    重算，事后就无法回答「这一轮的行为是被哪几条经验影响的」——而这正是
      //    「经验是否有效」唯一的归因依据。经验集合在 run 内必须恒定。
      // 2. 代价：getInjectableView() 要走 judge.effectiveness()（一次
      //    policy_injections × judge_runs 的分组聚合 + 一次深判统计）。10 轮任务
      //    会跑 10 次，而此前每轮只是 getPolicy() 一条 SELECT。
      //
      // 为什么「一次 run 一次求值」不是缓存而是对齐语义粒度：
      //  - 一个 run 期间**没有任何代码写** judge_runs / policy_injections（判决是
      //    run 结束后由 judge() 写入的），所以 effectiveness() 的结果本就不可能变；
      //  - recordInjections 自身按 (session, lesson) 去重，原本每轮调用也只落一次，
      //    移到 run 级后行为等价，还少掉 N-1 次重复的「查已有行」。
      //
      // 不变量：recordInjections 与 buildSystemPrompt 必须吃**同一个数组**。
      // 记账说注入了 N 条、prompt 里却是 M 条，lessonEffectiveness 的 injected
      // 就会系统性失真，经验有效性从此不可信。
      const injection = this.deps.policy?.getInjectableView();
      if (this.deps.judge && injection && injection.lessons.length > 0) {
        this.deps.judge.recordInjections(session.id, injection.version, injection.lessons);
      }
      const policyForPrompt = injection ? { ...injection.policy, lessons: injection.lessons } : undefined;

      // ── main loop ────────────────────────────────────────────────────────────
      // 自适应预算：推理型模型可能把 max_tokens 全花在 reasoning 上，导致
      // finish_reason=length 但无正文/无工具调用。只重试一次（见下方分支）。
      let maxTokens = req.maxTokens;
      let budgetAdapted = false;
      for (;;) {
        const term = checkTermination(budget, usage.promptTokens + usage.completionTokens);
        if (term.kind === 'stop') {
          // A-2：到顶不是抛错 —— 先把触顶记录写进 RunState，再走统一收尾。
          if (term.budget) {
            this.deps.runState?.budget(runId, { ...term.budget, triggeredAt: Date.now() });
          }
          this.finish(sse, session, term.finishReason as AgentFinishReason, budget.iteration, usage, term.detail, undefined, budget.tokenBudget, firstTokenMs());
          return;
        }

        // Rebuilt every turn so a mid-task MCP connect/disconnect stays reflected
        // (same cadence the native turn already used).
        const providerTools = this.deps.registry.toProviderTools(req.tools, {
          sandboxRoot: this.deps.sandboxRoot,
          mcpConnected: false,
        });

        // 注入视图在 run 级已求值一次（见 main loop 之前）：这里只消费结果，
        // 不再重算 —— 一个 run 内注入的经验集合必须恒定，否则事后无法归因。
        const view = await contextManager.buildView(
          session.id,
          req.provider,
          req.model,
          // 强化内核 Update 闭环：把当前 π' 注入本 run 的每一轮 Act（policy 未提供时退化为历史行为）。
          // 再叠加工作目录声明：模型不知道自己在哪，就会靠猜路径试错（实测 10 轮烧掉 68K token
          // 一个文件都没读到）。这段只在配置了沙箱根时追加，未配置时行为与历史一致。
          this.withWorkspace(
            buildSystemPrompt(req.taskKind, policyForPrompt),
            this.deps.sandboxRoot,
          ),
          // P1-3c: native turns ship the tool schemas in the request itself (often
          // thousands of tokens); ReAct embeds its catalogue in the system prompt
          // instead. Counting the schemas for the wrong channel would double-count
          // or miss them entirely, skewing the 75% trigger.
          // AUDIT-027：ReAct 的工具目录同样计入占用率估算（此前传 undefined 系统性低估，75% 触发滞后）。
          // 目录来自 selectTools 的 toolDefs，与 runReactTurn 实际嵌入系统提示词的同一份。
          channel === 'native' ? providerTools : renderToolCatalogue(toolDefs),
        );
        if (view.compactionFailed) {
          // AC-09: when the compaction summary fails its fidelity check the loop
          // stops with "context full" — it must not silently send the over-window
          // transcript upstream (which would only surface as an opaque 400).
          this.finish(
            sse,
            session,
            'context_full',
            budget.iteration,
            usage,
            `上下文已满：压缩自检未通过（缺：${view.compactionFailed.join('、')}），任务已回退。建议：新建会话，或把任务拆小后重试`,
            undefined,
            budget.tokenBudget,
            firstTokenMs(),
          );
          return;
        }
        budget.iteration += 1;

        const turnResult = await this.runTurn({
          sse, session, req, apiKey, messages: view.messages, providerTools, toolDefs,
          capabilities: decision.capabilities, turnSignal, channel, maxTokens, budget, usage,
          budgetAdapted, onFirstToken, firstTokenMs,
        });
        if (turnResult.kind === 'degraded') {
          channel = 'react';
          degraded = true;
          degradedReason = turnResult.reason;
          emitMeta(budget.iteration + 1, 'native', degradedReason);
          continue;
        }
        if (turnResult.kind === 'retry') {
          budgetAdapted = true;
          maxTokens = turnResult.maxTokens;
          continue;
        }
        if (turnResult.kind === 'terminated') {
          if (turnResult.error) traceStatus = 'error';
          return;
        }
        const turn = turnResult.turn;

        // ── final answer ───────────────────────────────────────────────────────
        if (turn.toolCalls.length === 0) {
          this.finishWithFinalAnswer({ sse, session, turn, budget, usage, firstTokenMs });
          return;
        }
        const round = await this.executeToolRound({
          sse, session, turn, budget, runId, channel, turnSignal, resolver, executor,
          breaker, detector, convergence, reportedCircuit, review, reviewCtx, traceId, usage, firstTokenMs,
        });
        if (round.terminated) return;
      }
    } finally {
      // 任何出口（正常 return、continue 到终点、或任一层抛错）都必须交还会话槽位，
      // 否则该 session 之后每一个请求都要先空等 35s 再被秒退（AUDIT-004）。
      this.finalizeRun({ runCancel: cancel, session, traceId, traceStatus, isFallback, clientIp, usage });
    }
  }

  /** 统一的 run 收尾：会话槽位、轨迹、兜底 Key 记账。所有出口都走这里。 */
  private finalizeRun(p: {
    runCancel?: RunCancellation;
    session: SessionRow;
    traceId: string | null;
    traceStatus: 'ok' | 'error';
    isFallback: boolean;
    clientIp: string;
    usage: Usage;
  }): void {
    p.runCancel?.dispose();
    this.deps.abortRegistry.release(p.session.id);
    if (p.traceId) {
      this.deps.trace?.endTrace(p.traceId, p.traceStatus);
      this.activeTraces.delete(p.session.id);
    }
    // A-01：兜底 Key 用量统一在此记账（含上游中途失败已恢复的部分用量，P0-1）。
    if (p.isFallback && this.deps.fallbackBudget) {
      this.deps.fallbackBudget.recordUsage(p.clientIp, p.usage.promptTokens + p.usage.completionTokens);
    }
  }

  /**
   * 执行一轮工具调用：解析 → 快照 → 批量执行 → 证据回填 → 观测回喂 → 收敛判定。
   * 返回 terminated=true 表示已在本方法内 finish()，调用方直接 return。
   */
  private async executeToolRound(p: {
    sse: SseWriter;
    session: SessionRow;
    turn: TurnIR;
    budget: BudgetState;
    runId: string;
    channel: Channel;
    turnSignal: AbortSignal;
    resolver: CallResolver;
    executor: ToolExecutor;
    breaker: CircuitBreaker;
    detector: LoopDetector;
    convergence: ConvergenceDetector;
    reportedCircuit: Set<string>;
    review: ReviewService | undefined;
    reviewCtx: ReviewContext;
    traceId: string | null;
    usage: Usage;
    firstTokenMs: () => number | null;
  }): Promise<{ terminated: boolean }> {
    const { sse, session, turn, budget, runId, channel, turnSignal, resolver, executor, breaker, detector, convergence, reportedCircuit, review, reviewCtx, traceId, usage, firstTokenMs } = p;
        // ── tool-call turn ─────────────────────────────────────────────────────
        // usageJson 必须写：这一轮的上游账单此前被整段丢掉（只有最终答案轮写），
        // 而一次 agent 运行里绝大多数是工具调用轮 —— 账单大面积静默丢失，
        // `latestPromptUsage()` 读它给压缩判定托底，等于在残缺数据上做决策。
        const toolCallsJson = JSON.stringify(
          turn.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.rawArguments || JSON.stringify(call.arguments) },
          })),
        );
        const assistant = this.deps.messages.insert({
          sessionId: session.id,
          role: 'assistant',
          content: turn.text,
          reasoningContent: turn.reasoning || null,
          toolCallsJson,
          segmentsJson: JSON.stringify([
            ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
            ...turn.toolCalls.map((call) => ({ type: 'tool', callId: call.id })),
          ]),
          usageJson: JSON.stringify(turn.usage),
          // 体积口径要含推理与工具调用（二者同样占上下文、同样被重发计费）。
          tokens: estimateAssistantTokens(turn.text, turn.reasoning, toolCallsJson),
        });
        this.deps.sessions.bumpCounters(session.id, 1, assistant.tokens);

        const resolved = await resolver.resolve(
          turn.toolCalls,
          session.id,
          assistant.id,
          budget.iteration,
          channel,
        );
        // AUDIT-003: the task-level cancellation source must reach every handler
        // (`ctx.signal`), or "stop" cannot cancel an already-approved write.
        //
        // ── 工作区快照：本轮文件修改前自动捕获 ────────────────────────────────
        // 拍的是「本轮将被写入的文件」，不是整个工作区：快照是安全网，不是备份系统。
        // 捕获失败不得阻断任务 —— 安全网自己出问题不能把主流程带崩。
        const filesToSnapshot = this.filesToSnapshot(resolved.items);
        // 新建文件执行前不存在，capture 拍不到；执行后按这份清单补 create 记录。
        const createdFiles = selectCreatedFiles(resolved.items);
        if (filesToSnapshot.length > 0) {
          try {
            await this.deps.checkpoint?.capture(session.id, {
              files: filesToSnapshot,
              runId,
              step: budget.iteration,
              toolCallIds: resolved.items.map((item) => item.toolCall.call_id),
            });
          } catch (err) {
            console.warn(
              '[checkpoint] 快照捕获失败，继续执行本轮工具:',
              err instanceof Error ? err.message : err,
            );
          }
        }
        this.deps.runState?.stage(runId, 'tool_call', `${resolved.items.length} 个调用`);
        // B：本轮开始前的 RunState 快照偏移，用于生成本轮「真实差异」签名。
        const stateBeforeTurn = this.deps.runState?.get(runId);
        const toolOffset = stateBeforeTurn?.tools.length ?? 0;
        const fileOffset = stateBeforeTurn?.fileChanges.length ?? 0;
        const outcomes = await executor.executeBatch(resolved.items, turnSignal);
        // A：工具调用总次数预算按实际执行批次累加（下一轮顶部统一判定）。
        budget.toolCallsUsed += resolved.items.length;

        // ── 执行后回填证据链（before/after + diff）─────────────────────────
        // 只对「本轮有写前快照」的工具做；失败不阻断主流程。
        let afterFiles: Array<{ path: string; added: number; removed: number; preview: string }> = [];
        let afterCheckpointId: string | null = null;
        if (filesToSnapshot.length > 0 && this.deps.checkpoint?.enabled) {
          try {
            const after = await this.deps.checkpoint.captureAfter(runId, budget.iteration, {
              files: filesToSnapshot,
              createdFiles,
              sessionId: session.id,
              toolCallIds: resolved.items.map((item) => item.toolCall.call_id),
            });
            if (after) {
              afterCheckpointId = after.checkpointId;
              afterFiles = after.files.map((f) => ({
                path: f.path,
                added: f.added,
                removed: f.removed,
                preview: f.diff.slice(0, 600),
              }));
              for (const f of after.files) {
                this.deps.runState?.fileChange(runId, {
                  path: f.path,
                  step: budget.iteration,
                  checkpointId: after.checkpointId,
                  beforeSha256: f.beforeSha256,
                  afterSha256: f.afterSha256,
                  added: f.added,
                  removed: f.removed,
                });
              }
            }
          } catch (err) {
            console.warn('[checkpoint] 执行后回填失败:', err instanceof Error ? err.message : err);
          }
        }

        // Circuit-blocked calls: synthesize outcomes without any LLM call (AC-08).
        const observations: Array<{ callId: string; content: string }> = [];
        for (const feedback of resolved.feedback) {
          observations.push({ callId: feedback.callId, content: feedback.observation });
        }
        for (const toolName of resolved.circuitBlocked) {
          if (reportedCircuit.has(toolName)) {
            // The model asked again after the breaker opened: stop the task.
            this.finish(sse, session, 'circuit_open', budget.iteration, usage, `工具 ${toolName} 已熔断，任务中止`, undefined, budget.tokenBudget, firstTokenMs());
            return { terminated: true };
          }
          reportedCircuit.add(toolName);
        }

        let loopAbort = false;
        for (const item of resolved.items) {
          const outcome = outcomes.get(item.toolCall.call_id);
          if (!outcome) continue;
          if (outcome.status === 'success') breaker.recordSuccess(item.toolCall.tool_name);
          else if (outcome.status === 'failed' || outcome.status === 'timeout') breaker.recordFailure(item.toolCall.tool_name);

          // 工具动作 span：把「模型调了什么工具、结果如何」落到轨迹上。
          // 只记工具名与成败，不记参数与返回体 —— 轨迹是要长期留存的可观测数据，
          // 参数里可能有路径、片段甚至密钥。
          this.recordSpan(traceId, {
            kind: 'act',
            name: item.toolCall.tool_name,
            status: outcome.status === 'success' ? 'ok' : 'error',
          });

          // RunState：每次工具调用的结构化记录（不含参数正文）。
          const effect = item.verdict.effect ?? null;
          this.deps.runState?.tool(runId, {
            callId: item.toolCall.call_id,
            name: item.toolCall.tool_name,
            iteration: budget.iteration,
            status:
              outcome.status === 'pending' || outcome.status === 'running'
                ? 'failed'
                : outcome.status,
            startedAt: Date.now(),
            durationMs: 0,
            risk: item.verdict.risk,
            approvalMode: item.verdict.approvalMode,
            effectReversible: effect ? effect.reversible : null,
            resultSummary: outcome.summary ? outcome.summary.slice(0, 200) : null,
            errorCode: outcome.errorKind ?? null,
          });

          // 可逆操作：默认放行，执行后出「结果审」卡（diff + 撤销 + 复核回填）。
          if (effect?.reversible && outcome.status === 'success') {
            const itemDiffs = afterFiles.filter((f) => effect.items.some((it) => it.path === f.path));
            sse.emit('result_review', {
              callId: item.toolCall.call_id,
              name: item.toolCall.tool_name,
              status: outcome.status,
              effect,
              runId,
              step: budget.iteration,
              checkpointId: afterCheckpointId,
              undoAvailable: Boolean(afterCheckpointId),
              diff: itemDiffs,
              review: null,
              reviewPending: Boolean(review),
            });
            // 复核并行回填：不阻塞主流程；结论到达后单独发 review_result。
            if (review) {
              const facts: ReviewFacts = buildReviewFacts(
                item,
                effect,
                outcome.summary,
                budget.iteration,
                itemDiffs,
              );
              void review
                .review(facts, reviewCtx, 'async', turnSignal)
                .then((result) => {
                  this.deps.runState?.addReviewCost(
                    runId,
                    result.usage.promptTokens,
                    result.usage.completionTokens,
                  );
                  sse.emit('review_result', { callId: item.toolCall.call_id, result });
                })
                .catch(() => {
                  /* 复核是旁路能力：失败不连累主流程，ReviewResult 内已记原因 */
                });
            }
          }

          const verdict = detector.record(item.toolCall.tool_name, item.args);
          let content = outcome.observation;
          if (verdict.kind === 'warn') content = `【系统提示】${verdict.message}\n${content}`;
          if (verdict.kind === 'abort') {
            loopAbort = true;
            content = `【系统提示】${verdict.message}`;
          }
          observations.push({ callId: outcome.callId, content });
        }

        // Every tool_call gets exactly one role:tool message (upstream 400 guard).
        for (const observation of observations) {
          const row = this.deps.messages.insert({
            sessionId: session.id,
            role: 'tool',
            content: observation.content,
            toolCallId: observation.callId,
            tokens: estimateTextTokens(observation.content),
          });
          this.deps.sessions.bumpCounters(session.id, 1, row.tokens);
        }

        if (loopAbort) {
          this.finish(sse, session, 'aborted', budget.iteration, usage, '检测到循环调用，任务已中止', undefined, budget.tokenBudget, firstTokenMs());
          return { terminated: true };
        }

        // B：收敛判定 —— 只读 RunState 相邻轮差异，模型自述不参与。
        if (this.deps.runState && config.agentConvergenceRounds > 0) {
          const afterState = this.deps.runState.get(runId);
          if (afterState) {
            const verdict = convergence.record(
              buildRoundSignature(afterState, toolOffset, fileOffset),
            );
            if (verdict.converged) {
              this.finish(
                sse,
                session,
                'converged',
                budget.iteration,
                usage,
                `连续 ${config.agentConvergenceRounds} 轮无新增文件改动 / 证据 / 工具结果变化，我判断已到头`,
                undefined,
                budget.tokenBudget,
                firstTokenMs(),
              );
              return { terminated: true };
            }
          }
        }
    return { terminated: false };
  }

  /** 最终答案轮的收尾：空响应分型、截断标记、落库与 finish。 */
  private finishWithFinalAnswer(p: {
    sse: SseWriter;
    session: SessionRow;
    turn: TurnIR;
    budget: BudgetState;
    usage: Usage;
    firstTokenMs: () => number | null;
  }): void {
    const { sse, session, turn, budget, usage, firstTokenMs } = p;
          /**
           * 空轮：没有正文、没有推理、没有工具调用，且这次上游一个 token 都没产出。
           *
           * 之前这里直接写一条空 assistant 消息并 `finish('stop')`，于是接口故障
           * 会以「模型什么都没做」的形态出现在 run_report 里（toolCallCount=0,
           * finishReason=stop）——和「模型只说不做」完全无法区分。实测撞到过：
           * 某网关上的 claude-3-5-sonnet 首字节回来了、流正常结束、0 token。
           * 现在单独报 UPSTREAM_EMPTY：调用方可以重试或换通道，
           * 失败归因也不会把它错记成模型的能力缺口。
           */
          const noOutput = turn.text.trim() === '' && turn.reasoning.trim() === '';
          const billed = turn.usage.completionTokens ?? 0;
          // 不能只看「0 token」：实测撞到过计费 94 token、正文与推理却都是空的轮次。
          // 旧判定放它走 finish('stop')，于是接口/解析故障以「模型什么都没说」的形态
          // 静默落库，调用方拿不到任何错误码。对调用方来说「有 token 但没内容」同样是
          // 上游空响应，而且更危险 —— 它连 UPSTREAM_EMPTY 都不会报。
          if (noOutput) {
            const message = billed === 0
              ? '上游返回空响应（无正文/无推理/无工具调用，0 token）'
              : `上游返回空响应（无正文/无推理/无工具调用，但计费 ${billed} token）`;
            sse.emitStage('upstream_empty', message);
            sse.emit('error', { code: 'UPSTREAM_EMPTY', message, retryable: true });
            this.deps.abortRegistry.markDone(session.id);
            this.deps.abortRegistry.release(session.id);
            this.approvalService.abortSession(session.id);
            return;
          }

          // 截断必须可见：finish_reason=length 时正文被 max_tokens 砍断，
          // 之前一律记成 'stop'，于是「写了一半」和「写完收工」看起来一样。
          const truncated = turn.finishReason === 'length';
          const detail = truncated
            ? '输出达到 max_tokens 上限被截断（finish_reason=length），这一轮没有产生工具调用'
            : undefined;
          const assistant = this.deps.messages.insert({
            sessionId: session.id,
            role: 'assistant',
            content: turn.text,
            reasoningContent: turn.reasoning || null,
            segmentsJson: JSON.stringify([{ type: 'text', text: turn.text }]),
            finishReason: truncated ? 'length' : 'stop',
            usageJson: JSON.stringify(turn.usage),
            // 体积口径含推理（此前只算正文，reasoning_content 被整段漏记）
            tokens: estimateAssistantTokens(turn.text, turn.reasoning, null),
          });
          this.deps.sessions.bumpCounters(session.id, 1, assistant.tokens);
          this.finish(sse, session, 'stop', budget.iteration, usage, detail, assistant.id, budget.tokenBudget, firstTokenMs());
          return;
  }

  /**
   * 从本轮工具调用里挑出「本轮将被改动的文件」路径，作为快照白名单。
   * 逻辑见模块级 `selectFilesToSnapshot`（纯函数，可直接单测）。
   */
  /**
   * 跑一轮上游调用：native/react 分支、工具参数被拒时降级、空响应抬预算重试。
   * 不在这里写最终答案或执行工具——那是 run() 的下一步。
   */
  private async runTurn(p: {
    sse: SseWriter; session: SessionRow;
    req: AgentRunRequest; apiKey: string;
    messages: Awaited<ReturnType<ContextManager['buildView']>>['messages'];
    providerTools: ReturnType<ToolRegistry['toProviderTools']>;
    toolDefs: ToolDefinition[];
    capabilities: Awaited<ReturnType<ChannelRouter['decide']>>['capabilities'];
    turnSignal: AbortSignal; channel: Channel; maxTokens: number;
    budget: BudgetState; usage: Usage; budgetAdapted: boolean;
    onFirstToken: (kind: 'reasoning' | 'content') => void; firstTokenMs: () => number | null;
  }): Promise<
    | { kind: 'turn'; turn: TurnIR }
    | { kind: 'degraded'; reason: string }
    | { kind: 'retry'; maxTokens: number }
    | { kind: 'terminated'; error?: boolean }
  > {
    const { sse, session, req, apiKey, messages, providerTools, toolDefs, capabilities, turnSignal, channel, maxTokens, budget, usage, budgetAdapted, onFirstToken, firstTokenMs } = p;
    let turn: TurnIR;
    try {
      turn = channel === 'native'
        ? await runNativeTurn({
            adapter: this.deps.adapter,
            providerId: req.provider,
            baseUrl: this.deps.providerBaseUrl(req.provider, req.customBaseUrl),
            apiKey,
            model: req.model,
            messages,
            tools: providerTools,
            temperature: req.temperature,
            maxTokens,
            capabilities,
            sse,
            signal: turnSignal,
            onResponseStart: () => sse.emitStage('upstream_first_byte'),
            onFirstToken,
          })
        : await runReactTurn({
            adapter: this.deps.adapter,
            providerId: req.provider,
            baseUrl: this.deps.providerBaseUrl(req.provider, req.customBaseUrl),
            apiKey,
            model: req.model,
            messages,
            tools: toolDefs,
            temperature: req.temperature,
            maxTokens: req.maxTokens,
            capabilities,
            sse,
            signal: turnSignal,
            onResponseStart: () => sse.emitStage('upstream_first_byte'),
            onFirstToken,
          });
    } catch (err) {
      const partial = (err as { partialUsage?: Usage }).partialUsage;
      if (partial) {
        usage.promptTokens += partial.promptTokens;
        usage.completionTokens += partial.completionTokens;
      }
      if (budget.aborted) {
        sse.emitStage('aborted', '任务已被用户中止');
        this.finish(sse, session, 'aborted', budget.iteration, usage, '任务已被用户中止', undefined, budget.tokenBudget, firstTokenMs());
        return { kind: 'terminated' };
      }
      if (channel === 'native' && ChannelRouter.shouldDegrade(err)) {
        budget.iteration -= 1;
        return { kind: 'degraded', reason: '上游拒绝 tools 参数，已自动切换提示词解析模式' };
      }
      const message = err instanceof Error ? err.message : String(err);
      const code = message.includes('超时') ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR';
      sse.emitStage(code === 'UPSTREAM_TIMEOUT' ? 'upstream_timeout' : 'upstream_error', message);
      sse.emit('error', { code, message, retryable: code === 'UPSTREAM_TIMEOUT' });
      this.deps.abortRegistry.markDone(session.id);
      this.deps.abortRegistry.release(session.id);
      this.approvalService.abortSession(session.id);
      return { kind: 'terminated', error: true };
    }

    usage.promptTokens += turn.usage.promptTokens;
    usage.completionTokens += turn.usage.completionTokens;

    if (
      turn.toolCalls.length === 0 &&
      turn.text.trim() === '' &&
      turn.finishReason === 'length' &&
      !budgetAdapted
    ) {
      const next = adaptOutputBudget(maxTokens);
      budget.iteration -= 1;
      sse.emitStage(
        'budget_adapted',
        `输出预算被推理耗尽（finish_reason=length），已自动提高到 ${next} 并重试本轮`,
      );
      return { kind: 'retry', maxTokens: next };
    }

    return { kind: 'turn', turn };
  }

  private filesToSnapshot(items: Array<{ toolCall: ToolCallRow; args: Record<string, unknown> }>): string[] {
    return selectFilesToSnapshot(items);
  }

  /**
   * 记录一条 span（观测面专用）。
   *
   * 三重防护，保证埋点永远不影响主流程：
   *   ① 没有 traceId 或未接入轨迹服务 → 直接返回；
   *   ② TraceService 内部对未启用与非法 kind 返回 null，不抛错；
   *   ③ 这里再兜一层 try/catch —— 万一观测侧出现未预期异常，
   *      也只留告警，不让任务因埋点失败。
   */
  private recordSpan(
    traceId: string | null | undefined,
    span: {
      kind: TraceSpanKind;
      name: string;
      status?: 'ok' | 'error';
      detail?: string;
      durationMs?: number;
    },
  ): void {
    if (!traceId || !this.deps.trace) return;
    try {
      this.deps.trace.recordSpan(traceId, span);
    } catch (err) {
      console.warn('[trace] span 记录失败:', err instanceof Error ? err.message : err);
    }
  }

  /** Used by the controller for pre-header session validation. */
  sessionExists(sessionId: string): boolean {
    return this.deps.sessions.get(sessionId) !== undefined;
  }

  /**
   * 追加工作目录声明。sandboxRoot 为空时原样返回，保持未配置沙箱时的历史行为。
   *
   * 放在这里而不是改 buildSystemPrompt 的签名：那个函数被多处测试直接调用，
   * 改签名会波及一批与本问题无关的用例；而「告诉模型它在哪」本质上是运行时
   * 上下文，属于 loop 的职责。
   */
  private withWorkspace(systemPrompt: string, sandboxRoot: string): string {
    if (!sandboxRoot) return systemPrompt;
    return `${systemPrompt}\n\n${buildRuntimeSections(sandboxRoot)}`;
  }

  private selectTools(names?: string[]): ToolDefinition[] {    const all = this.deps.registry.list();
    if (!names || names.length === 0) return all;
    return names
      .map((name) => this.deps.registry.get(name))
      .filter((def): def is ToolDefinition => def !== undefined);
  }

  /** AC-10 resume support: re-executes the target step with overridden arguments. */
  private async reExecuteStep(
    req: AgentRunRequest,
    target: ToolCallRow,
    executor: ToolExecutor,
    signal?: AbortSignal,
  ): Promise<void> {
    const def = this.deps.registry.get(target.tool_name);
    if (!def) {
      // P2-6: run() already deleted the original role:tool message
      // (deleteAfter), so exiting silently here leaves the assistant message
      // carrying tool_calls with no matching tool result — the next turn goes
      // upstream with an orphaned call and dies on HTTP 400.
      this.insertResumeToolFailure(target, `工具 ${target.tool_name} 已不在注册表中，无法重放该步骤`);
      return;
    }
    let args: Record<string, unknown>;
    try {
      args = req.overrideArguments ?? (JSON.parse(target.args_json) as Record<string, unknown>);
    } catch {
      args = {};
    }
    const gate = runGateway(def, args, {
      sandboxRoot: this.deps.sandboxRoot,
      allowedDirs: this.deps.sandboxPermissions?.allowDirs ?? [],
      exemptions: this.deps.sandboxPermissions?.autoApprove,
      checkpointEnabled: this.deps.checkpoint?.enabled,
    });
    if (!gate.ok) {
      // P2-6: same orphaned-call hazard as above (security denial path).
      this.insertResumeToolFailure(target, `工具 ${target.tool_name} 被安全策略拒绝：${gate.message}`);
      return;
    }
    const digest = argsDigest(gate.args);
    const row = this.deps.toolCalls.insert({
      sessionId: target.session_id,
      messageId: target.message_id,
      callId: target.call_id,
      toolName: target.tool_name,
      toolWireName: target.tool_wire_name,
      displayName: target.display_name,
      category: target.category,
      source: target.source,
      risk: gate.verdict.risk,
      approvalMode: gate.verdict.approvalMode,
      channel: target.channel as 'native' | 'react',
      iteration: target.iteration,
      argsJson: JSON.stringify(gate.args),
      argsDigest: digest,
    });
    const outcomes = await executor.executeBatch([
      {
        toolCall: row,
        definition: def,
        args: gate.args,
        digest,
        verdict: gate.verdict,
        channel: target.channel as 'native' | 'react',
        iteration: target.iteration,
      },
    ], signal);
    const outcome = outcomes.get(row.call_id);
    if (outcome) {
      this.deps.messages.insert({
        sessionId: target.session_id,
        role: 'tool',
        content: outcome.observation,
        toolCallId: outcome.callId,
        tokens: estimateTextTokens(outcome.observation),
      });
    }
  }

  /**
   * P2-6: feeds back one role:tool failure message for a resume step that
   * could not be replayed at all. Guarantees the upstream invariant "every
   * assistant tool_calls entry has exactly one tool result" even when the
   * rewind deleted the original answer and no new execution happened.
   */
  private insertResumeToolFailure(target: ToolCallRow, message: string): void {
    this.deps.messages.insert({
      sessionId: target.session_id,
      role: 'tool',
      content: message,
      toolCallId: target.call_id,
      tokens: estimateTextTokens(message),
    });
  }

  private finish(
    sse: SseWriter,
    session: SessionRow,
    finishReason: AgentFinishReason,
    iteration: number,
    usage: { promptTokens: number; completionTokens: number },
    detail?: string,
    messageId?: string,
    tokenBudget?: number,
    firstTokenMs?: number | null,
  ): void {
    // ── RunState 收尾 + 主动汇报卡 ──────────────────────────────────────────
    // 默认只在有实质变化（文件改动/不可逆/审批/错误/成本超阈值）时出卡；
    // 纯问答 no-tools 不插卡。RUN_REPORT_EVERY=1 时才每轮必报。
    const runId = sse.runId;
    if (runId && this.deps.runState && !this.reportedRuns.has(runId)) {
      this.reportedRuns.add(runId);
      // 预算触顶 / 收敛判定是「正常收尾但未完成」，不是异常：DB status 保持 ok，
      // 由 report.outcome + statusCode 区分（A-3：不得把预算耗尽记成完成或 error）。
      const normalEnd =
        finishReason === 'stop' ||
        finishReason === 'max_iterations' ||
        finishReason === 'budget_exhausted' ||
        finishReason === 'converged';
      const status: 'ok' | 'error' | 'aborted' =
        finishReason === 'aborted' ? 'aborted' : normalEnd ? 'ok' : 'error';
      this.deps.runState.stage(runId, finishReason === 'aborted' ? 'aborted' : 'done', detail ?? null);
      const report = this.deps.runState.finish(runId, status, finishReason, usage, detail ?? null);
      if (report && report.hasMaterialChange) {
        sse.emit('run_report', report);
      }
      // 保留策略：按 20 run / 200 MB 先到先淘汰；失败不阻断。
      if (this.deps.checkpoint) {
        void this.deps.checkpoint.prune().catch(() => {
          /* 淘汰失败不影响主流程 */
        });
      }
    }

    // 强化内核闭环：先由 Judge 产出结构化判决 r，再由 Update 消费 r 生成 π 增量。
    this.maybeDepositLesson(session, finishReason, iteration, usage, tokenBudget ?? 0);
    // 用完即清：同一 session 下一轮可能是测量轮（rsiMeasure=true）。
    this.nonMeasureSessions.delete(session.id);
    this.measureSampleCounts.delete(session.id);
    this.deps.abortRegistry.release(session.id);
    // P1-2 watchdog: no approval park may outlive its task. Anything still
    // parked at this point is stale (its loop is gone) — settle it so no
    // executor awaits a decision that can never arrive.
    this.approvalService.abortSession(session.id);
    if (detail) {
      sse.emit('delta', { text: `\n\n【${detail}】` });
    }
    // 阶段终局：done 在 done 事件之前发，前端可先收状态再收统计。
    sse.emitStage('done', detail ?? null);
    sse.emit('done', {
      finishReason,
      iteration,
      toolCallCount: this.deps.toolCalls.listBySession(session.id).length,
      usage,
      tokenBudget: tokenBudget ?? 0,
      messageId: messageId ?? '',
      firstTokenMs: firstTokenMs ?? null,
    });
  }

  /**
   * 闭环生产者：任务结束时把判决 r 折算成 π 增量（r → π'）。
   *
   * 有判据塔时 r 来自 Judge：结构化、可追溯（source_judgment 指向 run id），
   * 且 inconclusive（覆盖不足）不会凭空生成经验 —— 不知道错在哪就不该乱学。
   * 无判据塔时退化为按工具失败计数沉积，即历史行为。
   */
  private maybeDepositLesson(
    session: SessionRow,
    finishReason: AgentFinishReason,
    iteration: number,
    usage: { promptTokens: number; completionTokens: number },
    tokenBudget: number,
  ): void {
    if (!this.deps.policy) return;

    if (this.deps.judge) {
      const judge = this.deps.judge;
      const policy = this.deps.policy;
      const traceId = this.activeTraces.get(session.id);
      try {
        const run = judge.judge(session.id, {
          finishReason,
          iteration,
          tokenBudget,
          usage,
          // 熔断是本系统唯一以 circuit_open 收尾的路径；其它终止原因下
          // 即使中途开过路，对最终判决也没有额外信息量。
          circuitOpened: finishReason === 'circuit_open',
        });
        // 判决 span：判决是「这次任务到底算不算数」的答案，必须落在轨迹上。
        this.recordSpan(traceId, {
          kind: 'judge',
          name: `判决 #${run.runId ?? 0}`,
          status: run.verdict === 'fail' ? 'error' : 'ok',
          detail: `verdict=${run.verdict} score=${run.score}`,
        });
        const nextPolicy = policy.applyFromJudge(run, run.runId ?? 0);
        // 更新 span：只有真的改写了 π 才算一次 update（applyFromJudge 返回 null 表示没改）。
        if (nextPolicy) {
          this.recordSpan(traceId, {
            kind: 'update',
            name: `策略更新（判决 #${run.runId ?? 0}）`,
            status: 'ok',
            detail: `更新后经验共 ${nextPolicy.lessons.length} 条`,
          });
        }
        // ── RSI 旁路对账（L1 机械桥）─────────────────────────────────────────
        // 双轨并存：不阻断现有闭环，只在 Update 跑完之后再补一次跨代对比。
        // RSI bridge 自己 catch 所有异常返回 error/skipped；这里再套一层 try，
        // 确保 bridge 故障不会把 Judge/Update 这步也拖下水。
        // 干活轮（rsiMeasure=false）只学习、不测量：跳过跨代对账，
        // 让固定探针轮成为唯一的代际读数来源（避免开发噪声进 RSI）。
        if (!this.nonMeasureSessions.has(session.id)) {
          void this.runRsiBridge(session.id, run, traceId ?? null);
        }
      } catch (err) {
        // 判决与更新是旁路能力：它失败不应连累任务收尾与用户可见结果。
        // 但绝不静默 —— 留下可诊断的告警，且自证面板的 totalRuns 能看出它没在跑。
        console.warn('[judge] 判决/更新失败，本次不产生 π 增量:', err instanceof Error ? err.message : err);
      }
      return;
    }

    // ── 回退路径：未接入判据塔时的历史行为 ────────────────────────────────
    const corrective = this.deps.toolCalls
      .listBySession(session.id)
      .filter((t) => t.status === 'failed' || t.status === 'rejected' || t.status === 'timeout');
    if (corrective.length === 0) return;
    const names = [...new Set(corrective.map((t) => t.display_name))].slice(0, 5).join('、');
    this.deps.policy.applyUpdate(
      {
        addLessons: [
          `过往任务中以下工具执行未成功（${names}），再次使用前请先核对参数、沙箱路径与安全策略，避免重复失败。`,
        ],
      },
      `tool_outcome:${corrective.length}:${finishReason}`,
    );
  }

  /**
   * RSI 旁路对账：消费同一次 Judge 判决，生成跨代四态 verdict 并落审计表。
   *
   * 为什么是 async + void：spawn krsi 有 IO + subprocess 成本，放 run 收尾的同步路径
   * 里会让 SSE done 事件卡一下。fire-and-forget，靠 RsiBridgeService 内部 catch。
   *
   * 跳过条件（返回空 promise）：
   *   - rsi 没注入（内存库 / 没开 L1）
   *   - 本轮 verdict 没有 runId（Judge 自己判成 inconclusive 但没写行 —— 不应该发生，
   *     以防万一还是跳）
   */
  private runRsiBridge(
    sessionId: string,
    run: { verdicts: import('../judge/types.js').CriterionVerdict[]; runId?: number },
    traceId: string | null,
  ): void {
    if (!this.deps.rsi) return;
    if (!run.runId || run.runId <= 0) return;
    // 采样次数：测量轮由请求带入（>1 = 把最近 N 次同探针判决取均值）。
    const samples = this.measureSampleCounts.get(sessionId) ?? 1;

    // session-scoped generation 由 RsiBridgeService 自己算（基于 policy_rsi_runs 表），
    // 这里只传 hint（0 即可），彻底和 PolicyRepository 解耦。
    const db = (this.deps as { db?: import('../../repositories/db.js').Db }).db;
    void this.deps.rsi
      .compare(sessionId, 0, run.verdicts, run.runId, samples)
      .then(async (result) => {
        // 轨迹里记一笔：improved=ok，其他状态也 ok（都是有效判定，不区分 ok/error）
        // 但 error 单独标 error —— 它表示桥接自身故障，不是 RSI 判定结果
        this.recordSpan(traceId, {
          kind: 'judge', // 复用 judge span kind（它也是判决类行为）
          name: `RSI 对账（session内最新代）`,
          status: result.state === 'error' ? 'error' : 'ok',
          detail: `verdict=${result.state}${result.exitCode !== null ? ` exit=${result.exitCode}` : ''}`,
        });

        // ── LLM 归因：not_improved / refused 时触发 ──────────────────────────
        // 归因经验直接写 policy_injections 作为 π'，下一轮 run 会被 getInjectableView() 喂进 prompt。
        // 归因失败 catch 住不阻断主流程。
        const needsAttribution = result.state === 'not_improved' || result.state === 'refused';
        const hasCreds =
          !!this.deps.rsiAttributorApiKey &&
          !!this.deps.rsiAttributorBaseUrl &&
          !!this.deps.rsiAttributorModel;
        if (needsAttribution && hasCreds && db) {
          try {
            const { attributeDegradation } = await import('../rsi/rsi-attributor.js');
            // generation 对归因不是必需——policy_injections 用 policy_version 字段写，
            // 真实 session 的 policy 版本由 UpdateService.applyFromJudge 管理；
            // 我们这里传 1 只是满足类型，归因的关键输入是 result.reasons + run.verdicts
            const attrOut = await attributeDegradation({
              db,
              sessionId,
              // 审计表里的 policy_version 要写真实的 π 版本号，否则看板上
              // 「这条经验属于哪一版策略」永远指向 1，无法回溯。
              generation: this.deps.policy?.currentVersion() ?? 0,
              runVerdicts: run.verdicts,
              rsiResult: result,
              apiKey: this.deps.rsiAttributorApiKey!,
              baseUrl: this.deps.rsiAttributorBaseUrl!,
              model: this.deps.rsiAttributorModel!,
            });
            // 轨迹里再记一笔归因结果
            this.recordSpan(traceId, {
              kind: 'update',
              name: `RSI 归因`,
              status: attrOut.wroteRow ? 'ok' : (attrOut.failure ? 'error' : 'ok'),
              detail: attrOut.wroteRow
                ? `归因已落库: ${attrOut.lesson?.slice(0, 60) ?? ''}`
                : attrOut.failure ?? '无输出',
            });

            // ── 闭环最后一环：把归因经验真正并入 π' ────────────────────────
            // policy_injections 只是审计表；UpdateService.getPolicy() 只读
            // policy_versions。只写审计表的话，这条经验下一轮的 system prompt
            // 里根本不会出现 —— 那就是宣言点名的「r 没有真的改变 π'」。
            // 只有写进 policy_versions，getInjectableView() 才会把它注入下一次 Act。
            if (attrOut.wroteRow && attrOut.lesson && this.deps.policy) {
              try {
                const next = this.deps.policy.applyUpdate(
                  { addLessons: [attrOut.lesson] },
                  `rsi:${result.state}:${attrOut.lesson.slice(0, 48)}`,
                );
                this.recordSpan(traceId, {
                  kind: 'update',
                  name: `RSI 经验入 π`,
                  status: 'ok',
                  detail: `π' 现有 ${next.lessons.length} 条经验（下一轮 Act 会注入）`,
                });
              } catch (err) {
                console.warn('[rsi-attributor] 归因经验写入 π 失败:', err instanceof Error ? err.message : err);
              }
            }
          } catch (err) {
            console.warn('[rsi-attributor] 归因异常:', err instanceof Error ? err.message : err);
          }
        }
      })
      .catch((err) => {
        // 理论上 RsiBridgeService 内部已经 catch 了，但万一构造函数抛了
        console.warn('[rsi-bridge] 未预期异常（主路径兜底）:', err instanceof Error ? err.message : err);
      });
  }
}
