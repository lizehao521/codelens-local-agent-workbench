/** Tool registry types: canonical/wire naming, execution outcome, and context. */

import type { ToolErrorKind } from '../types/error-kind.js';

export type ToolCategory = 'http' | 'file' | 'compute' | 'mcp';
export type ToolRisk = 'low' | 'medium' | 'high';
export type ToolApprovalMode = 'none' | 'soft' | 'hard' | 'two_step';
export type ToolSource = 'builtin' | 'mcp';
export type ToolStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'rejected'
  | 'skipped';

/** JSON Schema object (draft-07 subset): no $ref / oneOf / patternProperties. */
export interface JsonSchemaObject {
  type: 'object';
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

export interface ToolExecutionContext {
  sessionId: string;
  toolCallId: string;
  callId: string;
  iteration: number;
  sandboxRoot: string;
  /** 沙箱外允许目录（白名单，已校验 + realpath 的绝对目录）；透传给 path-jail 放行允许范围内的路径。 */
  allowedDirs?: string[];
  signal: AbortSignal;
  reportProgress: (stage: string, message?: string) => void;
}

export interface ToolEnableContext {
  sandboxRoot: string;
  mcpConnected: boolean;
}

export interface ToolOutcome {
  ok: boolean;
  /** Machine-free summary shown on the card and fed back to the LLM. */
  summary: string;
  /** Structured payload; serialized into tool_results.inline_preview when small. */
  data?: Record<string, unknown>;
  error?: {
    code: string;
    kind: ToolErrorKind;
    message: string;
    suggestion?: string;
    retryable?: boolean;
  };
}

export interface ToolDefinition {
  /** Canonical dotted name; primary key, stored in DB and shown to users. */
  name: string;
  /** Wire name (underscores only); the ONLY form ever sent to the LLM. */
  wireName: string;
  displayName: string;
  category: ToolCategory;
  description: string;
  inputSchema: JsonSchemaObject;
  handler: (args: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<ToolOutcome>;
  timeoutMs: number;
  risk: ToolRisk;
  approvalMode: ToolApprovalMode;
  enabled: (ctx: ToolEnableContext) => boolean;
  source: ToolSource;
  idempotent: boolean;
  maxResultChars: number;
  mcpServerId?: string;
}

/** Projection served by `GET /api/v1/tools`. Never contains `handler`. */
export interface ToolDefinitionPublic {
  name: string;
  wireName: string;
  displayName: string;
  category: ToolCategory;
  description: string;
  inputSchema: JsonSchemaObject;
  risk: ToolRisk;
  approvalMode: ToolApprovalMode;
  enabled: boolean;
  source: ToolSource;
  timeoutMs: number;
  mcpServerId: string | null;
}

/**
 * 后果预览：不可逆操作的审批必须以「会发生什么」为主视图，而不是命令原文。
 *
 * 只描述可核实的事实（路径、存在性、字节数、条目数、是否可恢复），
 * 不推断模型意图。`reversible=false` 时审批走前置关键路径；
 * `reversible=true` 时默认放行，执行后以结果卡回填。
 */
export interface EffectItem {
  path: string;
  kind: 'file' | 'dir' | 'command' | 'url';
  exists: boolean;
  /** 文件字节数；目录/命令/URL 为 null。 */
  bytes: number | null;
  /** 目录条目数（仅 kind='dir' 时有值）。 */
  itemCount?: number;
}

export interface EffectPreview {
  reversible: boolean;
  summary: string;
  items: EffectItem[];
  itemCount: number;
  /** 是否已有可用的撤销入口（写前快照）。 */
  recoverable: boolean;
  recoveryNote: string | null;
  /** 目标在工作区外、尚未授权时，由调用方填充待授权目录。 */
  grantDir?: string | null;
  /** 审批内 diff：执行前就能看到将改哪些行（不依赖 checkpoint 是否开启）。 */
  diff?: ApprovalDiffItem[];
}

export interface ApprovalDiffItem {
  path: string;
  added: number;
  removed: number;
  /** unified diff 文本（已截断）。 */
  preview: string;
}

export type ReviewStatus = 'confirmed' | 'underestimated' | 'unexec';

export interface ReviewFinding {
  severity: 'high' | 'medium' | 'low';
  /** 复核给出的具体指摘（只针对事实）。 */
  claim: string;
  /** 指回哪一条事实（路径 / callId / 步骤）。 */
  factRef: string;
}

/** 一次独立复核的真实开销与结论。 */
export interface ReviewResult {
  status: ReviewStatus;
  findings: ReviewFinding[];
  usage: { promptTokens: number; completionTokens: number };
  latencyMs: number;
  provider: string;
  model: string;
  /** unexec 时的诚实原因（未配置 Key / 超时 / 解析失败）。 */
  reason?: string;
}

/**
 * 复核输入：只允许事实字段。
 *
 * 刻意**不**包含 messages / 计划 / 推理 / 模型自述——复核要独立于主脑，
 * 只回答「哪一条不可逆或影响面被低估」。
 */
export interface ReviewFactPath {
  path: string;
  operation: string;
  beforeExists: boolean;
  beforeBytes: number | null;
  afterExists: boolean;
  afterBytes: number | null;
}

export interface ReviewFacts {
  toolName: string;
  callId: string;
  iteration: number;
  /** 命令原文 / HTTP 方法 / URL 等执行事实（不含模型推理）。 */
  command?: string;
  cwd?: string;
  affectedPaths: ReviewFactPath[];
  itemCount: number;
  /** 真实副作用（退出码、stdout 摘要、HTTP 状态等）。 */
  sideEffects: string[];
  /** 执行后才有：真实 diff 摘要（截断）。 */
  diffSummary?: string;
}

/** Runtime risk verdict emitted with the `tool_call` event (baseline + actual arguments). */
export interface RiskVerdict {
  risk: ToolRisk;
  approvalMode: ToolApprovalMode;
  reason?: string;
  /** 不可逆/可逆操作的后果预览（由 runGateway 依据真实参数生成）。 */
  effect?: EffectPreview;
}

/** Result of translating an inbound tool call name back to a registry definition. */
export type ResolvedTool =
  | { ok: true; definition: ToolDefinition }
  | { ok: false; code: 'TOOL_NOT_FOUND'; message: string };
