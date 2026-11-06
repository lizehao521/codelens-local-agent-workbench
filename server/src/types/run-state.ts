/**
 * RunState：一次 run 的结构化状态。
 *
 * 约束（与总纲一致）：
 * - 每个阶段 / 工具调用 / 审批 / 文件改动 / 错误降级 / 成本都有时间戳；
 * - 不落凭证与工具参数正文（参数只留摘要与 callId）；
 * - 汇报卡里的每个数字都必须能在 RunState 里找到来源。
 */

export type RunStageName =
  | 'connecting'
  | 'upstream_first_byte'
  | 'reasoning'
  | 'content'
  | 'tool_call'
  | 'approval'
  | 'file_change'
  | 'done'
  | 'upstream_error'
  | 'upstream_timeout'
  | 'aborted';

export interface RunStageRecord {
  stage: RunStageName;
  at: number;
  elapsedMs: number;
  detail: string | null;
}

export interface RunToolRecord {
  callId: string;
  name: string;
  iteration: number;
  status: 'success' | 'failed' | 'timeout' | 'rejected' | 'skipped';
  startedAt: number;
  durationMs: number;
  risk: 'low' | 'medium' | 'high';
  approvalMode: 'none' | 'soft' | 'hard' | 'two_step';
  effectReversible: boolean | null;
  resultSummary: string | null;
  errorCode: string | null;
}

export interface RunApprovalRecord {
  callId: string;
  name: string;
  approvalMode: 'soft' | 'hard' | 'two_step';
  decision:
    | 'allow_once'
    | 'allow_session'
    | 'reject'
    | 'expired'
    | 'aborted'
    | 'revised'
    /** E：沿用了同一 run 内上一次可逆写入的授权（未弹卡）。 */
    | 'deduped';
  at: number;
  /** E：沿用哪一次授权（审批 id / 步骤号），撤销时可追溯。 */
  reusedGrantId?: string | null;
  reusedStep?: number | null;
}

/** A：触顶的是哪一道预算、上限、已用、在第几步触发。 */
export interface RunBudgetRecord {
  kind: 'iterations' | 'tool_calls' | 'tokens' | 'wall_clock';
  limit: number;
  used: number;
  atStep: number;
  triggeredAt: number;
}

/** A：收尾时的截止点 —— 已做什么、没做什么。 */
export interface RunCutoffRecord {
  lastStage: RunStageName | null;
  completedToolCalls: number;
  completedFileChanges: number;
  unfinished: string[];
}

export interface RunFileChangeRecord {
  path: string;
  step: number | null;
  checkpointId: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
  added: number;
  removed: number;
}

export interface RunErrorRecord {
  code: string;
  kind: 'error' | 'degraded' | 'retry' | 'timeout';
  message: string;
  at: number;
}

export interface RunCostRecord {
  promptTokens: number;
  completionTokens: number;
  reviewPromptTokens: number;
  reviewCompletionTokens: number;
  durationMs: number;
}

export interface RunStateData {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  channel: string | null;
  startedAt: number;
  endedAt: number | null;
  status: 'running' | 'ok' | 'error' | 'aborted';
  finishReason: string | null;
  stages: RunStageRecord[];
  tools: RunToolRecord[];
  approvals: RunApprovalRecord[];
  fileChanges: RunFileChangeRecord[];
  errors: RunErrorRecord[];
  cost: RunCostRecord;
  /** A：非 null 表示本次因预算触顶而收尾。 */
  budget: RunBudgetRecord | null;
  /** A：收尾截止点；正常完成时也为完整记录（unfinished 为空）。 */
  cutoff: RunCutoffRecord | null;
}

export type RunOutcome = 'completed' | 'budget_exhausted' | 'aborted' | 'error' | 'converged';

export interface RunReport {
  runId: string;
  sessionId: string;
  /** 与「任务完成」分离的终态码；前端据此使用不同文案（A-3）。 */
  outcome: RunOutcome;
  /** 机器可读状态码：RUN_COMPLETED / RUN_BUDGET_TOOL_CALLS / … */
  statusCode: string;
  /** 收尾原因（预算耗尽时写明哪道、第几步、已做什么、没做什么）。 */
  reason: string | null;
  /** 未完成项（正常完成时为空数组）。 */
  notDone: string[];
  hasMaterialChange: boolean;
  /** 为什么出卡（文件改动 / 不可逆 / 错误降级 / 审批 / 成本阈值）。 */
  triggers: string[];
  finishReason: string | null;
  fileChangeCount: number;
  irreversibleCount: number;
  approvalCount: number;
  errorCount: number;
  toolCallCount: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  /** 由 RunState 数字模板化生成的结论。 */
  summary: string;
}
