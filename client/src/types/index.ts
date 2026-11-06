// CodeLens 全局类型定义 —— 与 docs/agent/openapi.yaml、spec.md §5/§6 对齐
// v2.0：CodeLens 由「代码分析应用」演进为「通用 Agent 工具调用平台」

/** 四类核心能力（v1.0 遗留 task 字段，保留以兼容旧落盘数据） */
export type Task = 'analyze' | 'explain' | 'debug' | 'optimize';

export type Role = 'user' | 'assistant';

export type MessageStatus = 'streaming' | 'done' | 'error' | 'aborted';

export type ThemeMode = 'system' | 'dark' | 'light';

/** 发送给 LLM 的历史消息（openapi ChatRequest.messages） */
export interface ChatMessage {
  role: Role;
  content: string;
}

export interface MessageError {
  code: string;
  message: string;
}

// ── 服务端会话（SQLite 持久化，AC-05） ───────────────────────

/** GET /api/v1/sessions 列表项 / 创建返回的 session 投影 */
export interface ServerSession {
  id: string;
  title: string;
  provider: string;
  model: string;
  channelMode: 'auto' | 'native' | 'react';
  degraded: boolean;
  messageCount: number;
  totalTokens: number;
  createdAt: number;
  updatedAt: number;
}

/** GET /api/v1/sessions/:id 详情内的消息行（segments 已由服务端 JSON 化） */
export interface SessionMessageRow {
  id: string;
  seq: number;
  role: Role;
  content: string;
  segments: Segment[] | null;
  tokens: number;
  isSummary: boolean;
  createdAt: number;
  /** 本地流式态（服务端详情不带；刷新后由 reconcile 覆盖） */
  status?: MessageStatus;
  /** 流式累积的 reasoning 文本（thinking 模型） */
  reasoningText?: string;
}

/** GET /api/v1/sessions/:id 详情内的工具调用行（审计一等公民） */
export interface SessionToolCallRow {
  id: string;
  callId: string;
  /** 所属 assistant 消息 id（segments 含该 tool 段的那条）；消息被删后为 null */
  messageId?: string | null;
  toolName: string;
  displayName?: string | null;
  category: ToolCategory;
  source: ToolSource;
  risk: RiskLevel;
  approvalMode: ApprovalMode;
  channel: 'native' | 'react';
  iteration: number;
  arguments: Record<string, unknown> | string;
  status: ToolCallStatus;
  resultSummary?: string | null;
  resultRef?: string | null;
  durationMs?: number | null;
  truncated: boolean;
  startedAt?: number | null;
  endedAt?: number | null;
  errorKind?: string | null;
  /** 服务端落库的错误原文（error_msg）；detail 投影自 P1-6 起返回 */
  errorMessage?: string | null;
}

/** 详情内的审批历史行（审计用） */
export interface SessionApprovalRow {
  id: string;
  toolCallId: string;
  toolName: string;
  status: string;
  decision: string | null;
  decidedAt: number | null;
}

export interface SessionDetail {
  session: ServerSession;
  messages: SessionMessageRow[];
  toolCalls: SessionToolCallRow[];
  /**
   * 审批历史（仅审计展示）。注意：pending 挑战无法在这里恢复——
   * 审批 token 只存在于 SSE 流内（detail 不返回），且客户端断开即中止
   * 服务端 run，刷新后不存在"仍可操作"的待批挑战（P1-6 决策记录）。
   */
  approvals?: SessionApprovalRow[];
}

export interface SessionListResponse {
  items: ServerSession[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// ── Agent 工具调用平台：Segment 消息模型（架构 C-6） ──────────

export type ToolCategory = 'http' | 'file' | 'compute' | 'mcp';
export type ToolSource = 'builtin' | 'mcp';
export type RiskLevel = 'low' | 'medium' | 'high';
export type ApprovalMode = 'none' | 'soft' | 'hard' | 'two_step';

/** 七态状态机（openapi SseToolResult.status） */
export type ToolCallStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'rejected'
  | 'skipped';

/** SSE tool_result.error.kind 枚举（新增 kind 走前端兜底分支，不崩） */
export type ToolErrorKind =
  | 'invalid_args'
  | 'not_found'
  | 'security'
  | 'timeout'
  | 'rate_limit'
  | 'network'
  | 'upstream'
  | 'mcp'
  | 'circuit_open'
  | 'internal';

export interface ToolCallError {
  code: string;
  kind?: string;
  message: string;
  suggestion?: string;
  retryable?: boolean;
}

/** 工具调用视图模型（toolCallStore.byId 的值；tool segment 只存 callId 引用它） */
export interface ToolCallVM {
  callId: string;
  /** 规范名（点号），永不显示线上名（下划线） */
  name: string;
  displayName?: string;
  category: ToolCategory;
  source: ToolSource;
  /** MCP 来源时 = server 名 */
  mcpServer?: string;
  risk: RiskLevel;
  approvalMode: ApprovalMode;
  arguments: Record<string, unknown> | string;
  status: ToolCallStatus;
  iteration: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  /** tool_progress.message 或 stage 派生文案 */
  progress?: string;
  /** 服务端下发的摘要，前端原样渲染不做二次拼装 */
  summary?: string;
  resultText?: string;
  resultKind?: 'json' | 'text';
  contentType?: string;
  bytes?: number;
  truncated?: boolean;
  artifactPath?: string;
  resultId?: string;
  error?: ToolCallError;
  retryCount: number;
  /** 重试成功后记录「重试 N 次后成功」 */
  retrySucceededAfter?: number;
  /** 关联的挑战 id（tool_approval_required） */
  approvalId?: string;
  /** R6：可逆调用的执行后独立复核（并行回填） */
  review?: ReviewResult;
  /** 可逆调用已执行、复核尚未回填 */
  reviewPending?: boolean;
  /** E：本次沿用了同一 run 内上一次可逆授权（不弹卡，仅一行提示） */
  dedupNote?: { grantId: string; step: number; text: string };
}

// ── R6：后果预览 / 独立复核 / RunState 汇报卡 / 目录授权 ─────

export interface EffectItem {
  path: string;
  kind: 'file' | 'dir' | 'command' | 'url';
  exists: boolean;
  bytes: number | null;
  itemCount?: number;
}

export interface EffectPreview {
  reversible: boolean;
  summary: string;
  items: EffectItem[];
  itemCount: number;
  recoverable: boolean;
  recoveryNote: string | null;
  grantDir?: string | null;
}

export interface ReviewFinding {
  severity: 'low' | 'medium' | 'high';
  claim: string;
  factRef?: string;
}

export interface ReviewResult {
  status: 'confirmed' | 'underestimated' | 'unexec';
  findings: ReviewFinding[];
  reason?: string;
  usage: { promptTokens: number; completionTokens: number };
  latencyMs: number;
  model: string;
  promptVersion: string;
}

export type RunOutcome = 'completed' | 'budget_exhausted' | 'aborted' | 'error' | 'converged';

export interface RunReport {
  runId: string;
  sessionId: string;
  /** A/B：与「任务完成」分离的终态；前端文案必须按它分叉。 */
  outcome: RunOutcome;
  /** 机器可读状态码：RUN_COMPLETED / RUN_BUDGET_TOOL_CALLS / RUN_CONVERGED … */
  statusCode: string;
  /** 收尾原因（预算耗尽时写明哪道、第几步、已做什么、没做什么）。 */
  reason: string | null;
  notDone: string[];
  status: 'ok' | 'aborted' | 'error';
  finishReason: string | null;
  durationMs: number;
  iteration: number;
  toolCallCount: number;
  fileChangeCount: number;
  irreversibleCount: number;
  approvalCount: number;
  errorCount: number;
  promptTokens: number;
  completionTokens: number;
  reviewPromptTokens: number;
  reviewCompletionTokens: number;
  hasMaterialChange: boolean;
  triggers: string[];
  summary: string;
  at: number;
}

export interface SandboxGrantRequest {
  requestId: string;
  dir: string;
  sensitive: boolean;
  reason: string;
  expiresAt: number;
}

// ── D：审计台 / C：续跑冲突 ─────────────────────────────────

export interface RunAuditFileDiff {
  path: string;
  /** 'write' | 'create'：create 表示本 run 新建的文件（before 为空、撤销时删除）。 */
  operation: 'write' | 'create';
  step: number | null;
  checkpointId: string;
  toolCallIds: string[];
  added: number;
  removed: number;
  /** 快照落库时算好的历史 diff（绝不是用当前磁盘重算）。 */
  diff: string;
  beforeSha256: string | null;
  afterSha256: string | null;
}

export interface RunAuditStep {
  step: number | null;
  checkpointId: string;
  toolCallIds: string[];
  createdAt: number;
  status: 'active' | 'pruned';
  restoredAt: number | null;
  files: RunAuditFileDiff[];
}

export interface RunAuditFileEntry {
  path: string;
  /** 最后一次出现时的操作；create 在文件树标「新增」。 */
  operation?: 'write' | 'create';
  steps: Array<{
    step: number | null;
    checkpointId: string;
    status: 'active' | 'pruned';
    restoredAt: number | null;
    toolCallIds: string[];
  }>;
}

export interface RunAuditResponse {
  runId: string;
  report: RunReport | null;
  budget: Record<string, unknown> | null;
  cost: Record<string, unknown> | null;
  stages: AgentStagePayload[];
  approvals: Array<Record<string, unknown>>;
  files: RunAuditFileEntry[];
  steps: RunAuditStep[];
  fileCount: number;
  totalBytes: number;
  undo: { runAvailable: boolean; activeSnapshots: number };
}

export interface ResumeConflict {
  path: string;
  expectedSha256: string;
  actualSha256: string | null;
  step: number | null;
  checkpointId: string;
}

export type ResumeResponse =
  | {
      status: 'ok';
      plan: { runId: string; sessionId: string; resumeFromCallId: string | null; step: number | null };
    }
  | { status: 'conflict'; conflicts: ResumeConflict[] }
  | { status: 'not_found' }
  | { status: 'not_resumable'; reason: string };

export type ContextNoticeReason =
  | 'compacted'
  | 'compaction_failed'
  | 'tool_result_compressed'
  | 'truncated';

export interface ContextNotice {
  id: string;
  reason: ContextNoticeReason;
  removedMessages?: number;
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
  summaryPreview?: string;
}

/**
 * 消息内容段。tool 段只存 callId —— SSE 高频事件只改 toolCallStore.byId[callId]，
 * 不重写 segments 数组（否则整条消息全量 re-render）。
 */
export type Segment =
  | { type: 'text'; text: string }
  | { type: 'tool'; callId: string }
  | { type: 'notice'; notice: ContextNotice };

/** 任务结束成本（done 事件 + 客户端计时） */
export interface TaskRunInfo {
  iteration: number;
  toolCallCount: number;
  elapsedMs: number;
  usage?: TokenUsage;
  finishReason?: string;
}

export interface Message {
  id: string;
  role: Role;
  content: Segment[];
  /** 触发本条 AI 消息的能力（v1.0 遗留，assistant 消息可能有值） */
  task?: Task;
  createdAt: number;
  status: MessageStatus;
  error?: MessageError;
  /** 思考摘要（reasoning 事件累积），无则不渲染 ReasoningLine */
  reasoning?: string;
  /** 任务结束成本（仅 assistant 末条） */
  run?: TaskRunInfo;
}

// ── 审批（AC-04 / AC-06 / AC-10） ────────────────────────────

export type ApprovalDecision = 'allow_once' | 'allow_session' | 'reject' | 'revise';

/** 审批回执的呈现档位（404/409-already/410 → inline；409-mismatch → danger） */
export type ApprovalReceiptLevel = 'inline' | 'danger' | 'aborted';

export interface ApprovalReceipt {
  level: ApprovalReceiptLevel;
  message: string;
  /** 该挑战是否已被锁定（按钮全 disabled） */
  disabled: boolean;
  /** 需要的恢复动作（reload-args = 重新加载服务端参数） */
  action?: 'reload-args';
}

export interface ApprovalVM {
  approvalId: string;
  callId: string;
  token: string;
  name: string;
  displayName?: string;
  arguments: Record<string, unknown>;
  risk: RiskLevel;
  approvalMode: 'soft' | 'hard' | 'two_step';
  /** 为何拦下（影响范围 + 白名单/边界原因） */
  reason: string;
  expiresAt: number;
  mismatchCount: number;
  /** R6：不可逆操作的后果预览（可撤销路径为 null，不前置打断） */
  effect?: EffectPreview | null;
  receipt?: ApprovalReceipt;
  /** 移动端 ActionSheet 收起（≠ 拒绝） */
  collapsed?: boolean;
  /** 两步确认：当前是第几步确认（1-based）；非 two_step 模式不存在 */
  pass?: number;
  /** 两步确认：总共需要几步（two_step 固定为 2） */
  totalPasses?: number;
  /** 两步确认：用户已确认某非终步、等待下一步挑战到达前的瞬态锁定（按钮禁用） */
  awaitingNextStep?: boolean;
}

// ── 设置页契约 ──────────────────────────────────────────────

export interface ToolDefinitionPublic {
  name: string;
  wireName: string;
  displayName: string;
  category: ToolCategory;
  description?: string;
  inputSchema?: Record<string, unknown>;
  risk: RiskLevel;
  approvalMode: ApprovalMode;
  enabled?: boolean;
  source: ToolSource;
  timeoutMs?: number;
  mcpServerId?: string | null;
}

export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'failed';

export interface McpToolInfo {
  name: string;
  description?: string;
  risk: RiskLevel;
  enabled: boolean;
}

export interface McpServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled?: boolean;
  status: McpServerStatus;
  tools: string[];
  toolInfo?: McpToolInfo[];
  lastError?: string | null;
  connectedAt?: number | null;
}

export interface SecurityBoundary {
  httpAllowlist: { host: string; wildcard: boolean }[];
  fsRoot: string;
  toolTimeoutMs: number;
  taskRetryBudget: number;
  maxIterations: number;
}

// ── SSE 事件（事件名一律下划线，见 spec §11 已知坑） ──────────

export type AgentSSEEventType =
  | 'stage'
  | 'meta'
  | 'delta'
  | 'reasoning'
  | 'tool_call'
  | 'tool_progress'
  | 'tool_result'
  | 'tool_approval_required'
  | 'approval_dedup'
  | 'result_review'
  | 'review_result'
  | 'sandbox_grant_required'
  | 'run_report'
  | 'context_notice'
  | 'done'
  | 'error';

export interface AgentStagePayload {
  runId: string;
  stage:
    | 'connecting'
    | 'upstream_first_byte'
    | 'reasoning'
    | 'content'
    | 'done'
    | 'upstream_error'
    | 'upstream_timeout'
    | 'aborted';
  at: number;
  elapsedMs: number;
  detail: string | null;
}

export interface AgentMetaPayload {
  sessionId: string;
  messageId?: string;
  provider: string;
  model: string;
  channel: 'native' | 'react';
  degraded?: boolean;
  degradedReason?: string | null;
  iteration?: number;
  maxIterations?: number;
  contextWindow?: number;
  estimatedPromptTokens?: number;
  toolCount?: number;
  switchedFrom?: string | null;
  switchReason?: string | null;
}

export interface AgentDeltaPayload {
  text: string;
}

export interface AgentReasoningPayload {
  text: string;
}

export interface AgentToolCallPayload {
  callId: string;
  name: string;
  displayName?: string;
  category: ToolCategory;
  arguments: Record<string, unknown> | string;
  risk: RiskLevel;
  approvalMode: ApprovalMode;
  source?: ToolSource;
  iteration: number;
  status: 'pending';
}

export interface AgentToolProgressPayload {
  callId: string;
  stage: string;
  message?: string;
  at?: number;
}

export interface AgentToolResultPayload {
  callId: string;
  name: string;
  status: ToolCallStatus;
  summary?: string;
  data?: Record<string, unknown> | null;
  truncated?: boolean;
  durationMs?: number;
  resultId?: string;
  error?: ToolCallError;
}

export interface AgentApprovalPayload {
  callId: string;
  name: string;
  displayName?: string;
  category?: ToolCategory;
  arguments: Record<string, unknown>;
  risk: RiskLevel;
  approvalMode: 'soft' | 'hard' | 'two_step';
  reason: string;
  approvalId: string;
  approvalToken: string;
  expiresAt: number;
  iteration?: number;
  /** R6：不可逆操作的后果预览（路径/存在性/字节数/条目数/可恢复性） */
  effect?: EffectPreview | null;
}

/** E：可逆写入第二次起沿用上次授权时的一行提示（不弹审批卡）。 */
export interface AgentApprovalDedupPayload {
  callId: string;
  name: string;
  reusedGrantId: string;
  reusedStep: number;
  text: string;
}

export interface AgentContextNoticePayload {
  reason: ContextNoticeReason;
  removedMessages?: number;
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
  summaryPreview?: string;
}

export interface AgentDonePayload {
  finishReason: string;
  iteration: number;
  toolCallCount: number;
  messageId: string;
  usage?: TokenUsage;
  /** B-07：首 token 延迟（ms）；无内容时 null。 */
  firstTokenMs?: number | null;
}

export interface AgentErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
}

// ── 请求体 ──────────────────────────────────────────────────

export interface AgentStreamRequest {
  sessionId?: string;
  provider: string;
  model: string;
  apiKey?: string;
  /** 自定义 Provider（provider='custom'）的 Base URL，透传给服务端 resolveBaseUrl */
  customBaseUrl?: string;
  message: string;
  tools?: string[];
  channelMode?: 'auto' | 'native' | 'react';
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  /** AC-10：从该 callId 重跑（其后步骤置 skipped） */
  resumeFromCallId?: string;
  /** AC-10：与 resumeFromCallId 搭配的改参数重试 */
  overrideArguments?: Record<string, unknown>;
  /** 四类任务模式（analyze/explain/debug/optimize）；缺省=自动，模型自定 */
  taskKind?: Task;
}

export interface ApprovalSubmitRequest {
  token: string;
  decision: ApprovalDecision;
  reason?: string;
  arguments?: Record<string, unknown>;
}

// ── v1.0 遗留（保留兼容） ────────────────────────────────────

export interface CodeContext {
  language: string;
  filename?: string;
  code: string;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  codeContext: CodeContext;
  /** 本会话记住的授权条数（allow_session 累加，用于 ShieldCheck 标记） */
  grantedApprovals?: number;
}

export interface Settings {
  provider: string;
  model: string;
  apiKey: string;
  customBaseUrl?: string;
  theme: ThemeMode;
  /** Agent 通道偏好（AC-01：auto 时跟随服务端能力探测） */
  channelMode?: 'auto' | 'native' | 'react';
}

/** 模型调用限制（/providers limits 字段）。null = 上游未标注。 */
export interface ModelLimits {
  maxOutputTokens: number | null;
  rateLimitRpm: number | null;
  rateLimitTpm: number | null;
  maxConcurrent: number | null;
}

/** 模型能力（/providers capabilities 字段，服务端已合并探测/同步/默认三级）。 */
export interface ModelCapabilities {
  nativeTools: boolean;
  toolChoiceValues: string[];
  contextWindow: number;
  retainReasoningContent: boolean;
  requireToolStreamFlag: boolean;
  explicitParallelToolCalls: boolean;
}

export type ModelProbeStatus = 'unknown' | 'supported' | 'unsupported' | 'failed';

export interface ProviderModel {
  id: string;
  name: string;
  /** 能力（降级目录可能缺失 → 显示「未知」） */
  capabilities?: ModelCapabilities;
  /** 调用限制（降级目录可能缺失） */
  limits?: ModelLimits;
  /** 探测状态 */
  probeStatus?: ModelProbeStatus;
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  models: ProviderModel[];
  defaultModel: string;
  docsUrl: string;
}

export interface ChatRequest {
  provider: string;
  model: string;
  apiKey?: string;
  task: Task;
  messages: ChatMessage[];
  codeContext?: CodeContext;
  temperature?: number;
  maxTokens?: number;
  customBaseUrl?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResponse {
  content: string;
  finishReason: string;
  usage?: TokenUsage;
}

export type SSEEventType = 'meta' | 'delta' | 'done' | 'error';

export interface SSEMeta {
  provider: string;
  model: string;
}

export interface SSEDelta {
  text: string;
}

export interface SSEDone {
  finishReason: string;
  usage?: TokenUsage;
}

export interface SSEError {
  code: string;
  message: string;
}

/** openapi 错误码表 + 客户端网络错误 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'MISSING_API_KEY'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'NETWORK_ERROR';
