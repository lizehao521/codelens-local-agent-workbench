/** Shared type definitions for the CodeLens Agent platform. */

export type TaskKind = 'analyze' | 'explain' | 'debug' | 'optimize';

export type MessageRole = 'user' | 'assistant';

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export interface CodeContext {
  language: string;
  filename?: string;
  code: string;
}

/** Validated chat request payload (after zod parsing). */
export interface ChatRequest {
  provider: string;
  model: string;
  apiKey?: string;
  task: TaskKind;
  messages: ChatMessage[];
  codeContext?: CodeContext;
  temperature: number;
  maxTokens: number;
  customBaseUrl?: string;
}

export type UpstreamRole = 'system' | 'user' | 'assistant' | 'tool';

/** Internal normalized message sent to upstream LLM (role 'tool' added for function results). */
export interface UpstreamMessage {
  role: UpstreamRole;
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: UpstreamToolCallRequest[];
}

/** Outbound tool call in provider wire format (uses the underscore wire name). */
export interface UpstreamToolCallRequest {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Function descriptor sent upstream. `name` must be the sanitized wire name. */
export interface ProviderToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/** Normalized upstream events consumed by the service layer. */
export type UpstreamEvent =
  | { type: 'meta'; provider: string; model: string }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_calls'; calls: NormalizedToolCall[] }
  | { type: 'done'; finishReason: string; usage: Usage };

/** A tool call reconstructed from streamed upstream deltas. `name` is the wire name. */
export interface NormalizedToolCall {
  index: number;
  id: string;
  name: string;
  rawArguments: string;
  arguments: Record<string, unknown>;
  parseError?: 'EMPTY_ARGS' | 'INVALID_JSON' | 'MISSING_ID' | 'MISSING_NAME';
}

/** SSE event names sent to the browser. Always underscore (never kebab-case). */
export type SseEventName =
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

/** 模型调用限制（能力标签的「限制度量」来源）。null = 上游未标注。 */
export interface ModelLimits {
  maxOutputTokens: number | null;
  rateLimitRpm: number | null;
  rateLimitTpm: number | null;
  maxConcurrent: number | null;
}

export interface ProviderModel {
  id: string;
  name: string;
  /** 上游同步下发的模型级能力（覆盖静态默认）。 */
  capabilities?: { function_calling?: boolean; context_window?: number };
  /** 上游同步下发的模型级调用限制（覆盖 provider 默认）。 */
  limits?: Partial<ModelLimits>;
}

export interface ProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  models: ProviderModel[];
  defaultModel: string;
  docsUrl: string;
}

/** Static per-provider capability defaults; probed rows take precedence. */
export interface ProviderCapabilities {
  nativeTools: boolean;
  toolChoiceValues: Array<'auto' | 'none' | 'required' | 'named'>;
  contextWindow: number;
  retainReasoningContent: boolean;
  requireToolStreamFlag: boolean;
  explicitParallelToolCalls: boolean;
  /**
   * 是否支持 `role:"system"`。NVIDIA 的 integrate.api.nvidia.com/v1 会直接拒绝
   * system 角色（400 "Conversation roles must alternate"），此类 provider 需把
   * system 提示词折叠进首条 user 消息。默认 true（OpenAI 兼容语义）。
   */
  supportsSystemRole?: boolean;
}

export type ProbeStatus = 'unknown' | 'supported' | 'unsupported' | 'failed';
