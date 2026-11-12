/**
 * Tool executor: the only place tool handlers are invoked.
 * Responsibilities (architecture 7.5): approval gate → run with per-tool timeout
 * → one bounded auto-retry for retryable kinds → result truncation + artifact
 * offload → audit persistence → tool_result SSE event.
 * Parallel calls run 4-at-a-time; anything beyond is serialized.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolCallRow } from '../memory/tool-call.repository.js';
import type { ToolResultRepository } from '../memory/tool-result.repository.js';
import type {
  EffectPreview,
  ReviewFacts,
  ReviewResult,
  ToolDefinition,
  ToolExecutionContext,
  ToolOutcome,
  RiskVerdict,
} from '../../types/tool.js';
import type { SseWriter } from '../agent/sse-writer.js';
import type { ApprovalService } from '../agent/approval.service.js';
import type { ApprovalDedupService } from '../agent/approval-dedup.service.js';
import { RETRYABLE_KINDS } from '../../types/error-kind.js';
import { renderToolObservation, serializeToolData } from './observation-render.js';

/**
 * 回灌渲染（「模型看到什么」）已拆到 `observation-render.ts`：那段逻辑决定了
 * 模型能读到多少原文，混在 700 行执行器里既改不动也测不动。这里保留 re-export，
 * 是因为既有用例与调用方从这里取这两个符号，对外契约不变。
 */
export { clipToTokenBudget, OBSERVATION_MAX_TOKENS } from './observation-render.js';

export interface ExecuteItemInput {
  toolCall: ToolCallRow;
  definition: ToolDefinition;
  args: Record<string, unknown>;
  digest: string;
  verdict: RiskVerdict;
  channel: 'native' | 'react';
  iteration: number;
}

export interface ExecutorDeps {
  toolCalls: import('../memory/tool-call.repository.js').ToolCallRepository;
  toolResults: ToolResultRepository;
  approvals: ApprovalService;
  sse: SseWriter;
  sandboxRoot: string;
  /** 沙箱外允许目录（白名单，已校验 + realpath 的绝对目录）；透传给 path-jail 放行允许范围内的路径。 */
  allowedDirs: string[];
  /** Task-level retry budget (5 per task); consumed once per auto-retry. */
  canRetry: () => boolean;
  onRetryConsumed: () => void;
  /** 不可逆调用的同步复核（关键路径等待结论）。 */
  reviewIrreversible?: (facts: ReviewFacts) => Promise<ReviewResult | null>;
  /** E：当前 run 标识（去重键的一部分）。 */
  runId?: string;
  /** E：同一 run 内的可逆审批去重登记表。 */
  dedup?: ApprovalDedupService;
  /** E：沿用了哪一次授权（供 RunState 留痕）。 */
  onApprovalDedup?: (info: {
    toolCall: ToolCallRow;
    reusedGrantId: string;
    reusedStep: number;
  }) => void;
  /** 每次审批结论（含拒绝/过期/中止），供 RunState 记录。 */
  onApprovalDecision?: (info: {
    toolCall: ToolCallRow;
    approvalMode: 'soft' | 'hard' | 'two_step';
    decision: 'allow_once' | 'allow_session' | 'reject' | 'expired' | 'aborted' | 'revised_direct';
  }) => void;
}

/** What the loop feeds back to the LLM as the `role: tool` message content. */
export interface ExecutionOutcome {
  callId: string;
  toolCallId: string;
  toolName: string;
  status: import('../memory/tool-call.repository.js').ToolCallStatus;
  summary: string;
  observation: string;
  errorKind: string | null;
}

const INLINE_PREVIEW_CHARS = 4000;
const PARALLEL_LIMIT = 4;
/** AUDIT-005: how many independent confirmations a `two_step` verdict needs. */
const TWO_STEP_PASSES = 2;

/**
 * AUDIT-005: labels the confirmation step so the approval card can say which
 * one of the two the user is looking at. A silent identical second prompt reads
 * like a UI glitch, and users approve what looks like a repeat.
 */
function passReason(reason: string | undefined, pass: number, requiredPasses: number): string {
  const base = reason ?? '该操作需要用户确认';
  if (requiredPasses <= 1) return base;
  return pass === requiredPasses ? `最终确认（第 ${pass}/${requiredPasses} 步）：${base}` : `第 ${pass}/${requiredPasses} 步确认：${base}`;
}

/**
 * P2-3: result integrity checksum. The column shipped but was hardwired to
 * null at both insert points, so the audit chain had no way to detect a
 * tampered or truncated result row. Payload-less results (no data) stay null
 * — there is nothing to verify.
 */
function sha256Of(serialized: string): string | null {
  if (!serialized) return null;
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * 把「执行前」的后果预览转成复核事实。
 * 只放事实（路径/操作/存在性/条目数/命令），不携带主脑推理与计划。
 */
function plannedFacts(item: ExecuteItemInput): ReviewFacts {
  const effect = item.verdict.effect;
  const args = item.args;
  const affectedPaths = (effect?.items ?? [])
    .filter((it) => it.kind === 'file' || it.kind === 'dir')
    .map((it) => ({
      path: it.path,
      operation: String(args.operation ?? item.definition.name),
      beforeExists: it.exists,
      beforeBytes: it.bytes,
      afterExists: false,
      afterBytes: null,
    }));
  const sideEffects: string[] = [];
  if (effect?.summary) sideEffects.push(effect.summary);
  if (item.definition.name === 'http.request') {
    sideEffects.push(`${String(args.method ?? 'GET').toUpperCase()} ${String(args.url ?? '')}`);
  }
  return {
    toolName: item.definition.name,
    callId: item.toolCall.call_id,
    iteration: item.iteration,
    command: typeof args.command === 'string' ? args.command : undefined,
    cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
    affectedPaths,
    itemCount: effect?.itemCount ?? 1,
    sideEffects,
  };
}

export class ToolExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  /**
   * Runs a batch of calls; chunks of 4 in parallel, remainder serialized.
   *
   * `signal` is the task-level cancellation source (AUDIT-003). It is threaded
   * down to every handler's `ctx.signal`; when absent the executor falls back to
   * a per-call signal so handlers never receive an unusable one.
   */
  async executeBatch(items: ExecuteItemInput[], signal?: AbortSignal): Promise<Map<string, ExecutionOutcome>> {
    const outcomes = new Map<string, ExecutionOutcome>();
    for (let start = 0; start < items.length; start += PARALLEL_LIMIT) {
      const chunk = items.slice(start, start + PARALLEL_LIMIT);
      const results = await Promise.all(chunk.map((item) => this.executeOne(item, signal)));
      for (const outcome of results) if (outcome) outcomes.set(outcome.callId, outcome);
    }
    return outcomes;
  }

  private async executeOne(item: ExecuteItemInput, signal?: AbortSignal): Promise<ExecutionOutcome | null> {
    const { toolCall, definition } = item;
    const sessionId = toolCall.session_id;

    // ── approval gate ────────────────────────────────────────────────────────
    // AUDIT-005: `two_step` means the call must clear TWO independent
    // confirmations. The gateway has always advertised the double gate for
    // deleting the sandbox root (the one irreversible action in the catalogue),
    // but nothing consumed the verdict — a single allow wiped everything. Each
    // pass issues its own challenge, and a session grant never satisfies it
    // (otherwise an earlier allow_session would open the door on later calls).
    const approvalMode = item.verdict.approvalMode;
    const requiredPasses = approvalMode === 'two_step' ? TWO_STEP_PASSES : 1;
    // R6 审批语义：`soft` 表示「可逆，默认放行 + 事后审结果」，不再前置打断；
    // 只有不可逆的 hard/two_step 才走前置审批（审后果预览）。
    const mustChallenge =
      (approvalMode === 'hard' || approvalMode === 'two_step') &&
      (approvalMode === 'two_step' ||
        !this.deps.approvals.hasSessionGrant(sessionId, toolCall.tool_name, item.digest));
    // E：可逆写入的第二次起沿用本 run 内同目录同操作的上一次授权。
    // 不可逆 / 敏感路径 / 越界目录在 keyFor 里直接返回 null（红线，永不去重）。
    const dedupEligible =
      mustChallenge && this.deps.runId && this.deps.dedup
        ? this.deps.dedup.keyFor({
            runId: this.deps.runId,
            toolName: toolCall.tool_name,
            effect: item.verdict.effect ?? null,
            sandboxRoot: this.deps.sandboxRoot,
            allowedDirs: this.deps.allowedDirs,
          })
        : null;
    let dedupHit = false;
    if (dedupEligible && this.deps.dedup) {
      const reused = this.deps.dedup.lookup(dedupEligible.key);
      if (reused) {
        dedupHit = true;
        this.deps.sse.emit('approval_dedup', {
          callId: toolCall.call_id,
          name: toolCall.tool_name,
          reusedGrantId: reused.grantId,
          reusedStep: reused.step,
          text: '已按你上次的授权执行，可撤销',
        });
        this.deps.onApprovalDedup?.({
          toolCall,
          reusedGrantId: reused.grantId,
          reusedStep: reused.step,
        });
      }
    }

    if (mustChallenge && !dedupHit) {
      let issuedGrantId: string | null = null;
      let issuedStep = item.iteration;
      for (let pass = 1; pass <= requiredPasses; pass += 1) {
        const decision = await this.deps.approvals.requestApproval(
          {
            sessionId,
            toolCall,
            args: item.args,
            digest: item.digest,
            reason: passReason(item.verdict.reason, pass, requiredPasses),
            effect: item.verdict.effect ?? null,
            onIssued: (approvalId) => {
              issuedGrantId = approvalId;
              issuedStep = item.iteration;
            },
          },
          this.deps.sse,
        );
        this.deps.onApprovalDecision?.({
          toolCall,
          approvalMode: approvalMode as 'soft' | 'hard' | 'two_step',
          decision,
        });
        if (decision === 'reject' || decision === 'expired' || decision === 'aborted') {
          const base =
            decision === 'reject'
              ? '用户拒绝了这次调用'
              : decision === 'expired'
                ? '审批已过期（5 分钟有效期），调用未执行'
                : '审批已被中止，调用未执行';
          const message =
            requiredPasses > 1 ? `两步确认未走完（第 ${pass}/${requiredPasses} 步）：${base}` : base;
          this.deps.toolCalls.markFinished(toolCall.id, { status: 'rejected', errorKind: 'revised', errorMsg: message });
          this.deps.sse.emit('tool_result', {
            callId: toolCall.call_id,
            name: toolCall.tool_name,
            status: 'rejected',
            summary: message,
            data: null,
            truncated: false,
            durationMs: 0,
            resultId: '',
            error: {
              code: decision === 'reject' ? 'TOOL_REJECTED' : 'TOOL_APPROVAL_EXPIRED',
              kind: decision === 'reject' ? 'not_found' : 'timeout',
              message,
              retryable: false,
            },
          });
          return {
            callId: toolCall.call_id,
            toolCallId: toolCall.id,
            toolName: toolCall.tool_name,
            status: 'rejected',
            summary: message,
            observation: `工具 ${toolCall.tool_name} 未执行：${message}`,
            errorKind: decision === 'reject' ? 'not_found' : 'timeout',
          };
        }
        // A parameter revision re-arms the challenge under the SAME park, so an
        // allow decision may now refer to a successor row carrying NEW arguments
        // (the approval token binds the new args_digest). Every allow path must
        // therefore resolve to the latest pending row of this callId — executing
        // the stale row would run parameters the user never approved (P0-3).
        if (decision === 'revised_direct' || decision === 'allow_once' || decision === 'allow_session') {
          // Not the last confirmation yet: go back and ask again. Executing here
          // would make the second step decorative.
          if (pass < requiredPasses) continue;
          // 首次授权成功后登记，供本 run 后续同类可逆写入沿用。
          // revised_direct 携带的是「改过参数」的新授权，不当作同操作登记。
          if (
            decision !== 'revised_direct' &&
            dedupEligible &&
            issuedGrantId &&
            this.deps.dedup
          ) {
            this.deps.dedup.remember(dedupEligible.key, issuedGrantId, issuedStep);
          }
          const successor = this.latestPendingByCallId(sessionId, toolCall.call_id);
          if (!successor) {
            // P2-6: the approved row vanished (consumed by a concurrent path,
            // e.g. a resume rewind). Returning null used to drop this call's
            // observation entirely — but its assistant message still carries
            // the tool_calls entry, so the next turn would go upstream with an
            // orphaned call (HTTP 400). Synthesize a failure outcome instead,
            // so exactly one role:tool message is always fed back.
            const message = '该调用已被其他路径处理，未能执行';
            this.deps.sse.emit('tool_result', {
              callId: toolCall.call_id,
              name: toolCall.tool_name,
              status: 'failed',
              summary: message,
              data: null,
              truncated: false,
              durationMs: 0,
              resultId: '',
              error: { code: 'TOOL_NOT_FOUND', kind: 'not_found', message, retryable: false },
            });
            return {
              callId: toolCall.call_id,
              toolCallId: toolCall.id,
              toolName: toolCall.tool_name,
              status: 'failed',
              summary: message,
              observation: `工具 ${toolCall.tool_name} 未执行：${message}`,
              errorKind: 'not_found',
            };
          }
          if (successor.id === toolCall.id) {
            // No revision happened: the approved row is the one we were handed.
            return this.runAndRecord(
              toolCall,
              definition,
              item.args,
              item.channel,
              item.iteration,
              signal,
              item.verdict.effect,
            );
          }
          return this.runAndRecord(
            successor,
            definition,
            this.parseArgs(successor.args_json),
            successor.channel as 'native' | 'react',
            successor.iteration,
            signal,
            undefined,
          );
        }
      }
    }

    // ── 不可逆：执行前同步复核（关键路径等待结论）───────────────────────
    // 只喂事实；复核只回答「哪一条不可逆或影响面被低估」。
    // 若复核认定影响面被低估，则把发现写回审批理由并要求重新确认。
    const effect = item.verdict.effect;
    if (this.deps.reviewIrreversible && effect && !effect.reversible) {
      const review = await this.deps.reviewIrreversible(plannedFacts(item));
      if (review) {
        this.deps.sse.emit('review_result', { callId: toolCall.call_id, result: review });
        if (review.status === 'underestimated') {
          const findings = review.findings.map((f) => f.claim).join('；') || '复核认为影响面可能被低估';
          const decision = await this.deps.approvals.requestApproval(
            {
              sessionId,
              toolCall,
              args: item.args,
              digest: item.digest,
              reason: `复核提示（风险升级，需重新确认）：${findings}`,
              effect,
            },
            this.deps.sse,
          );
          this.deps.onApprovalDecision?.({
            toolCall,
            approvalMode: approvalMode as 'soft' | 'hard' | 'two_step',
            decision,
          });
          if (decision !== 'allow_once' && decision !== 'allow_session' && decision !== 'revised_direct') {
            const message =
              decision === 'reject' ? '复核提示后用户拒绝执行' : '复核后的确认已过期或中止，调用未执行';
            return this.rejectOutcome(
              toolCall,
              message,
              decision === 'reject' ? 'TOOL_REJECTED' : 'TOOL_APPROVAL_EXPIRED',
              decision === 'reject' ? 'not_found' : 'timeout',
            );
          }
        }
      }
    }

    return this.runAndRecord(
      toolCall,
      definition,
      item.args,
      item.channel,
      item.iteration,
      signal,
      effect,
    );
  }

  /** 统一的「未执行」落账 + SSE，供复核后拒绝等路径复用。 */
  private rejectOutcome(
    toolCall: ToolCallRow,
    message: string,
    code: string,
    kind: 'not_found' | 'timeout',
  ): ExecutionOutcome {
    this.deps.toolCalls.markFinished(toolCall.id, { status: 'rejected', errorKind: 'revised', errorMsg: message });
    this.deps.sse.emit('tool_result', {
      callId: toolCall.call_id,
      name: toolCall.tool_name,
      status: 'rejected',
      summary: message,
      data: null,
      truncated: false,
      durationMs: 0,
      resultId: '',
      error: { code, kind, message, retryable: false },
    });
    return {
      callId: toolCall.call_id,
      toolCallId: toolCall.id,
      toolName: toolCall.tool_name,
      status: 'rejected',
      summary: message,
      observation: `工具 ${toolCall.tool_name} 未执行：${message}`,
      errorKind: kind,
    };
  }

  private latestPendingByCallId(sessionId: string, callId: string): ToolCallRow | undefined {
    return this.deps.toolCalls.listBySession(sessionId).find((row) => row.call_id === callId && row.status === 'pending');
  }

  private parseArgs(argsJson: string): Record<string, unknown> {
    try {
      return JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private async runAndRecord(
    toolCall: ToolCallRow,
    definition: ToolDefinition,
    args: Record<string, unknown>,
    channel: 'native' | 'react',
    iteration: number,
    signal?: AbortSignal,
    effect?: EffectPreview,
  ): Promise<ExecutionOutcome> {
    this.deps.toolCalls.markRunning(toolCall.id);
    const startedAt = Date.now();

    let attempt = 0;
    for (;;) {
      attempt += 1;
      // AUDIT-003: the TASK-level signal is what the handler must observe. The
      // per-attempt controller below is only a stand-in for callers that pass
      // none (its signal can never fire, which is exactly the orphan the audit
      // flagged); preferring `signal` makes "stop" reach an in-flight tool.
      const callSignal = signal ?? new AbortController().signal;
      const outcome = await this.runHandler(definition, args, toolCall, callSignal, iteration);
      const durationMs = Date.now() - startedAt;

      if (outcome.ok) {
        return this.recordSuccess(toolCall, outcome, durationMs, definition, args);
      }

      const kind = outcome.error?.kind ?? 'internal';
      const retryable = RETRYABLE_KINDS.includes(kind) && outcome.error?.retryable !== false;
      // AC-08 kind table：非幂等工具只有「天然只读」的 GET/HEAD 才允许自动重试，
      // 覆盖 network/upstream/timeout/rate_limit 等所有 RETRYABLE_KINDS——
      // 否则重试一个非幂等 POST/PUT（5xx/超时）会重复写副作用。
      const method = typeof args.method === 'string' ? String(args.method).toUpperCase() : undefined;
      const idempotentSafe = definition.idempotent || (method !== undefined && ['GET', 'HEAD'].includes(method));
      // P2-1: `mcp` is a RETRYABLE_KIND, but retrying a non-idempotent external
      // write duplicates a side effect (MCP servers expose writes, deletes,
      // payments). Read-only / idempotent-hinted MCP tools are registered
      // idempotent by the adapter and may still auto-retry.
      const mcpSafe = definition.source !== 'mcp' || definition.idempotent;
      if (attempt === 1 && retryable && idempotentSafe && mcpSafe && this.deps.canRetry()) {
        this.deps.onRetryConsumed();
        this.deps.sse.emit('tool_progress', {
          callId: toolCall.call_id,
          stage: 'retrying',
          message: `第 ${attempt} 次失败（${kind}），自动重试一次`,
          at: Date.now(),
        });
        continue;
      }
      return this.recordFailure(toolCall, outcome, durationMs);
    }
  }

  private async runHandler(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    toolCall: ToolCallRow,
    outerSignal: AbortSignal,
    iteration: number,
  ): Promise<ToolOutcome> {
    // AUDIT-003: this is the ONE controller whose signal reaches the handler.
    // Previously a second, local controller was created and only that orphan
    // received the timer's abort, while `ctx.signal` came from a controller
    // nothing ever aborted. A press of "stop" therefore left an already-approved
    // write running to completion. Both cancellation sources now land here.
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    if (outerSignal.aborted) forwardAbort();
    else outerSignal.addEventListener('abort', forwardAbort, { once: true });
    // 任务级中止必须立刻结算：只留 timer 这条腿时，用户按停止后任务看上去要卡满
    // definition.timeoutMs（http 工具 30s）才会返回。
    const aborted = new Promise<never>((_resolve, reject) => {
      if (outerSignal.aborted) reject(new Error('ABORTED'));
    });
    // The handler leg may win and leave this pending; never let it float as an
    // unhandled rejection when it settles later.
    aborted.catch(() => undefined);

    const ctx: ToolExecutionContext = {
      sessionId: toolCall.session_id,
      toolCallId: toolCall.id,
      callId: toolCall.call_id,
      iteration,
      sandboxRoot: this.deps.sandboxRoot,
      allowedDirs: this.deps.allowedDirs,
      signal: controller.signal,
      reportProgress: (stage, message) => {
        this.deps.sse.emit('tool_progress', { callId: toolCall.call_id, stage, message, at: Date.now() });
      },
    };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error('TOOL_TIMEOUT'));
        reject(new Error('TOOL_TIMEOUT'));
      }, definition.timeoutMs);
    });
    try {
      return await Promise.race([definition.handler(args, ctx), timeout, aborted]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'TOOL_TIMEOUT') {
        return {
          ok: false,
          summary: `工具执行超时（${definition.timeoutMs}ms）`,
          error: {
            code: 'TOOL_TIMEOUT',
            kind: 'timeout',
            message: `工具在 ${definition.timeoutMs}ms 内未返回`,
            suggestion: '可重试或调整参数',
            retryable: true,
          },
        };
      }
      if (outerSignal.aborted || /abort/i.test(message)) {
        return {
          ok: false,
          summary: '任务已中止',
          error: { code: 'TOOL_ABORTED', kind: 'internal', message: '任务已被用户中止', retryable: false },
        };
      }
      return {
        ok: false,
        summary: `工具内部错误：${message.slice(0, 200)}`,
        error: { code: 'TOOL_INTERNAL', kind: 'internal', message: `工具内部错误：${message.slice(0, 200)}`, retryable: false },
      };
    } finally {
      if (timer) clearTimeout(timer);
      outerSignal.removeEventListener('abort', forwardAbort);
    }
  }

  private async recordSuccess(
    toolCall: ToolCallRow,
    outcome: ToolOutcome,
    durationMs: number,
    definition: ToolDefinition,
    args: Record<string, unknown>,
  ): Promise<ExecutionOutcome> {
    const serialized = serializeToolData(outcome.data);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    const truncated = serialized.length > INLINE_PREVIEW_CHARS;
    let artifactPath: string | null = null;
    let artifactWritten = false;
    if (truncated) {
      const relPath = `.artifacts/${toolCall.id}.json`;
      // Awaited rather than fire-and-forget: the audit row must not advertise an
      // artifact that failed to land, and the observation must not point the
      // model at a missing file (P1-1).
      artifactWritten = await this.writeArtifact(relPath, serialized);
      artifactPath = artifactWritten ? relPath : null;
    }
    const result = this.deps.toolResults.insert({
      toolCallId: toolCall.id,
      inlinePreview: truncated ? serialized.slice(0, INLINE_PREVIEW_CHARS) : serialized || null,
      artifactPath,
      bytes,
      truncated,
      sha256: sha256Of(serialized),
    });
    this.deps.toolCalls.markFinished(toolCall.id, {
      status: 'success',
      resultRef: result.id,
      resultSummary: outcome.summary,
      truncated,
    });
    this.deps.sse.emit('tool_result', {
      callId: toolCall.call_id,
      name: toolCall.tool_name,
      status: 'success',
      summary: outcome.summary,
      data: outcome.data ?? null,
      truncated,
      durationMs,
      resultId: result.id,
    });
    // 喂给模型的内容两道闸，都收在 observation-render 里：先按**工具自己声明的
    // 字符预算**裁（`maxResultChars` —— 它此前是死元数据：12 处声明、0 处读取，
    // 正是 C2「加了模块但没人调用」），再按全局 token 硬顶裁。渲染层同时拿到
    // 结构化 payload 与全量序列化，因此可以按语义取字段，而不是只能对一串 JSON
    // 做字符前缀裁剪。审计链（sha256 / bytes / artifact）仍以全量 serialized 为准。
    const observation = renderToolObservation({
      toolName: toolCall.tool_name,
      summary: outcome.summary,
      data: outcome.data,
      serialized,
      artifactPath,
      maxResultChars: definition.maxResultChars,
      args,
    });
    return {
      callId: toolCall.call_id,
      toolCallId: toolCall.id,
      toolName: toolCall.tool_name,
      status: 'success',
      summary: outcome.summary,
      observation,
      errorKind: null,
    };
  }

  private recordFailure(toolCall: ToolCallRow, outcome: ToolOutcome, durationMs: number): ExecutionOutcome {
    const kind = outcome.error?.kind ?? 'internal';
    const status = kind === 'timeout' ? 'timeout' : 'failed';
    const serialized = outcome.data === undefined ? '' : JSON.stringify(outcome.data);
    const result = this.deps.toolResults.insert({
      toolCallId: toolCall.id,
      inlinePreview: serialized.slice(0, INLINE_PREVIEW_CHARS) || null,
      artifactPath: null,
      bytes: Buffer.byteLength(serialized, 'utf8'),
      truncated: false,
      sha256: sha256Of(serialized),
    });
    this.deps.toolCalls.markFinished(toolCall.id, {
      status,
      errorKind: kind,
      errorMsg: outcome.error?.message ?? outcome.summary,
      resultRef: result.id,
      resultSummary: outcome.summary,
    });
    this.deps.sse.emit('tool_result', {
      callId: toolCall.call_id,
      name: toolCall.tool_name,
      status,
      summary: outcome.summary,
      data: outcome.data ?? null,
      truncated: false,
      durationMs,
      resultId: result.id,
      error: {
        code: outcome.error?.code ?? 'TOOL_FAILED',
        kind,
        message: outcome.error?.message ?? outcome.summary,
        suggestion: outcome.error?.suggestion,
        retryable: outcome.error?.retryable ?? false,
      },
    });
    const suggestion = outcome.error?.suggestion ? `建议：${outcome.error.suggestion}` : '';
    return {
      callId: toolCall.call_id,
      toolCallId: toolCall.id,
      toolName: toolCall.tool_name,
      status,
      summary: outcome.summary,
      observation: `工具 ${toolCall.tool_name} 执行失败（${kind}）：${outcome.error?.message ?? outcome.summary}${suggestion ? `\n${suggestion}` : ''}`,
      errorKind: kind,
    };
  }

  /** Writes the offloaded result; returns whether the file actually landed. */
  private async writeArtifact(relPath: string, content: string): Promise<boolean> {
    try {
      const abs = path.resolve(this.deps.sandboxRoot, relPath);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
      return true;
    } catch (err) {
      // Best-effort offload: the inline preview still carries the data, but the
      // failure is now logged and surfaced to the model instead of silent.
      console.warn(`[artifact] 写入失败 ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
