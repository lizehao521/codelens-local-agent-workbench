/** SSE payload contracts shared with the client. Event names are always underscore. */

import type { EffectPreview, ReviewResult, ToolApprovalMode, ToolCategory, ToolRisk, ToolSource, ToolStatus } from './tool.js';
import type { ToolErrorKind } from './error-kind.js';
import type { RunReport } from './run-state.js';

export interface SseMetaPayload {
  sessionId: string;
  messageId: string;
  provider: string;
  model: string;
  channel: 'native' | 'react';
  degraded: boolean;
  degradedReason: string | null;
  iteration: number;
  maxIterations: number;
  contextWindow: number;
  /** 任务累计 token 硬顶（上下文窗口 × TOKEN_BUDGET_CONTEXT_FACTOR）。 */
  tokenBudget: number;
  estimatedPromptTokens: number;
  toolCount: number;
  switchedFrom: string | null;
  switchReason: string | null;
}

export interface SseDeltaPayload {
  text: string;
}

export interface SseReasoningPayload {
  text: string;
}

export interface SseToolCallPayload {
  callId: string;
  name: string;
  displayName: string;
  category: ToolCategory;
  arguments: Record<string, unknown>;
  risk: ToolRisk;
  approvalMode: ToolApprovalMode;
  source: ToolSource;
  iteration: number;
  status: 'pending';
}

export interface SseToolProgressPayload {
  callId: string;
  stage: string;
  message?: string;
  at: number;
}

export interface ToolResultError {
  code: string;
  kind: ToolErrorKind;
  message: string;
  suggestion?: string;
  retryable: boolean;
}

export interface SseToolResultPayload {
  callId: string;
  name: string;
  status: ToolStatus;
  summary: string;
  data: Record<string, unknown> | null;
  truncated: boolean;
  durationMs: number;
  resultId: string;
  error?: ToolResultError;
}

export interface SseToolApprovalRequiredPayload {
  callId: string;
  name: string;
  displayName: string;
  arguments: Record<string, unknown>;
  risk: ToolRisk;
  approvalMode: ToolApprovalMode;
  reason: string;
  /** 不可逆操作的后果预览；可逆操作没有前置审批，因此该字段为 null。 */
  effect: EffectPreview | null;
  approvalId: string;
  approvalToken: string;
  expiresAt: number;
}

/** E：可逆写入第二次起沿用上次授权时的一行提示（不弹审批卡）。 */
export interface SseApprovalDedupPayload {
  callId: string;
  name: string;
  /** 沿用的原始授权 id / 步骤号，供撤销追溯。 */
  reusedGrantId: string;
  reusedStep: number;
  text: string;
}

/** 可逆操作执行后的结果审卡片。 */
export interface SseResultReviewPayload {
  callId: string;
  name: string;
  status: 'success' | 'failed' | 'timeout';
  effect: EffectPreview | null;
  runId: string | null;
  step: number | null;
  checkpointId: string | null;
  undoAvailable: boolean;
  diff: {
    path: string;
    added: number;
    removed: number;
    preview: string;
  }[];
  /** 异步复核回填后的结论；未回填时为 null。 */
  review: ReviewResult | null;
  /** 本调用确实会做异步复核（前端据此显示「复核中」而不是永远空着）。 */
  reviewPending: boolean;
}

/** 独立复核回填事件（可逆路径异步、不可逆路径同步后也会发一次）。 */
export interface SseReviewResultPayload {
  callId: string;
  result: ReviewResult;
}

/** 目录授权请求：工作区外首次访问弹一次，记住后不再弹。 */
export interface SseSandboxGrantRequiredPayload {
  requestId: string;
  dir: string;
  sensitive: boolean;
  reason: string;
  expiresAt: number;
}

export interface SseRunReportPayload extends RunReport {}

export type ContextNoticeReason =
  | 'compacted'
  | 'compaction_failed'
  | 'tool_result_compressed'
  | 'truncated';

export interface SseContextNoticePayload {
  reason: ContextNoticeReason;
  removedMessages: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  summaryPreview: string;
}

export type AgentFinishReason =
  | 'stop'
  | 'max_iterations'
  | 'budget_exhausted'
  | 'aborted'
  | 'circuit_open'
  | 'context_full'
  | 'stream_interrupted'
  /** B：连续 N 轮无新增文件改动 / 证据 / 工具结果变化，主动停。 */
  | 'converged';

export interface SseDonePayload {
  finishReason: AgentFinishReason;
  iteration: number;
  toolCallCount: number;
  usage: { promptTokens: number; completionTokens: number };
  tokenBudget: number;
  messageId: string;
  /** B-07：从 run 开始到上游首个内容块（delta/reasoning/tool_call）的毫秒数；未产生内容时为 null。 */
  firstTokenMs: number | null;
}

export interface SseErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * 运行阶段（R3）：请求一旦被接受就先发 connecting，避免上游长尾时用户面对静止界面。
 * 阶段只增不减、单调推进；`upstream_error` / `upstream_timeout` / `aborted` 是终局分支，
 * 前端据此区分「连不上」「回得慢」「被中止」，而不是所有失败都落进同一个 catch。
 */
export type AgentRunStage =
  | 'connecting'
  | 'upstream_first_byte'
  | 'reasoning'
  | 'content'
  | 'done'
  | 'upstream_error'
  | 'upstream_timeout'
  | 'aborted';

export interface SseStagePayload {
  /** 本次 run 的标识（与 sessionId 无关，重试会换新 runId）。 */
  runId: string;
  stage: AgentRunStage;
  /** 阶段发生的绝对时间（epoch ms）。 */
  at: number;
  /** 距请求被接受的毫秒数，用于前端计时与后续耗时归因。 */
  elapsedMs: number;
  /** 失败/超时阶段的诊断信息（不含密钥）；正常阶段为 null。 */
  detail: string | null;
}

/** Maps each event name to its payload so writers cannot mix them up. */
export interface AgentEventMap {
  stage: SseStagePayload;
  meta: SseMetaPayload;
  delta: SseDeltaPayload;
  reasoning: SseReasoningPayload;
  tool_call: SseToolCallPayload;
  tool_progress: SseToolProgressPayload;
  tool_result: SseToolResultPayload;
  tool_approval_required: SseToolApprovalRequiredPayload;
  approval_dedup: SseApprovalDedupPayload;
  result_review: SseResultReviewPayload;
  review_result: SseReviewResultPayload;
  sandbox_grant_required: SseSandboxGrantRequiredPayload;
  run_report: SseRunReportPayload;
  context_notice: SseContextNoticePayload;
  done: SseDonePayload;
  error: SseErrorPayload;
}

export type AgentEventName = keyof AgentEventMap;

export type AgentEvent = {
  [K in AgentEventName]: { type: K; payload: AgentEventMap[K] };
}[AgentEventName];

/** Every event name in protocol order (stage first, done/error last). */
export const AGENT_EVENT_NAMES: readonly AgentEventName[] = [
  'stage',
  'meta',
  'delta',
  'reasoning',
  'tool_call',
  'tool_progress',
  'tool_result',
  'tool_approval_required',
  'approval_dedup',
  'result_review',
  'review_result',
  'sandbox_grant_required',
  'run_report',
  'context_notice',
  'done',
  'error',
];
