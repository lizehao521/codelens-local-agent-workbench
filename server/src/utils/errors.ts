/** Application error type and canonical error codes (architecture detail section 3.2). */

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  MISSING_API_KEY: 'MISSING_API_KEY',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  /**
   * 上游返回了「空轮」：首字节到了、流正常结束，但没有正文、没有推理、没有工具调用，
   * completionTokens 为 0。实测某网关上的 claude-3-5-sonnet 就是这样（firstTokenMs=null）。
   *
   * 单独一个错误码，因为它和「模型选择不做事」长得几乎一样：都会在 run_report 里
   * 表现为 toolCallCount=0 / finishReason=stop。前者该重试或切通道，后者该换模型——
   * 不分开就会把接口故障记成模型能力缺口（失败归因的 behavior 层）。
   */
  UPSTREAM_EMPTY: 'UPSTREAM_EMPTY',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // ---- Agent platform additions (spec section 5 / architecture detail 3.2) ----
  AGENT_BUSY: 'AGENT_BUSY',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  RECOVERY_CODE_INVALID: 'RECOVERY_CODE_INVALID',
  RECOVERY_LOCKED: 'RECOVERY_LOCKED',
  APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  APPROVAL_ALREADY_DECIDED: 'APPROVAL_ALREADY_DECIDED',
  APPROVAL_TOKEN_MISMATCH: 'APPROVAL_TOKEN_MISMATCH',
  APPROVAL_ARGS_MISMATCH: 'APPROVAL_ARGS_MISMATCH',
  APPROVAL_REVISE_LIMIT: 'APPROVAL_REVISE_LIMIT',
  APPROVAL_NOT_REVISABLE: 'APPROVAL_NOT_REVISABLE',
  APPROVAL_ABORTED: 'APPROVAL_ABORTED',
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  TOOL_DISABLED: 'TOOL_DISABLED',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  MCP_SERVER_NOT_FOUND: 'MCP_SERVER_NOT_FOUND',
  MCP_COMMAND_INVALID: 'MCP_COMMAND_INVALID',
  MCP_CONNECT_FAILED: 'MCP_CONNECT_FAILED',
  // ---- 可观测面（能力洞察）：工作区快照 / 技能库 ----
  CHECKPOINT_DISABLED: 'CHECKPOINT_DISABLED',
  CHECKPOINT_NOT_FOUND: 'CHECKPOINT_NOT_FOUND',
  CHECKPOINT_PATH_ESCAPE: 'CHECKPOINT_PATH_ESCAPE',
  CHECKPOINT_MANIFEST_INVALID: 'CHECKPOINT_MANIFEST_INVALID',
  SKILL_ALREADY_EXISTS: 'SKILL_ALREADY_EXISTS',
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_ERROR: 400,
  MISSING_API_KEY: 401,
  BUDGET_EXCEEDED: 429,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  NOT_FOUND: 404,
  UPSTREAM_ERROR: 502,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_EMPTY: 502,
  INTERNAL_ERROR: 500,
  AGENT_BUSY: 429,
  SESSION_NOT_FOUND: 404,
  RECOVERY_CODE_INVALID: 404,
  RECOVERY_LOCKED: 423,
  APPROVAL_NOT_FOUND: 404,
  APPROVAL_EXPIRED: 410,
  APPROVAL_ALREADY_DECIDED: 409,
  APPROVAL_TOKEN_MISMATCH: 409,
  APPROVAL_ARGS_MISMATCH: 409,
  APPROVAL_REVISE_LIMIT: 409,
  APPROVAL_NOT_REVISABLE: 409,
  APPROVAL_ABORTED: 409,
  TOOL_NOT_FOUND: 404,
  TOOL_DISABLED: 409,
  TOOL_TIMEOUT: 504,
  MCP_SERVER_NOT_FOUND: 404,
  MCP_COMMAND_INVALID: 400,
  MCP_CONNECT_FAILED: 502,
  // 可观测面：能力未开启 / 对象不存在 / 路径越界 / 清单损坏
  CHECKPOINT_DISABLED: 409,
  CHECKPOINT_NOT_FOUND: 404,
  CHECKPOINT_PATH_ESCAPE: 400,
  CHECKPOINT_MANIFEST_INVALID: 400,
  SKILL_ALREADY_EXISTS: 409,
  SKILL_NOT_FOUND: 404,
};

/** Error with a stable machine-readable code and mapped HTTP status. */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status?: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code] ?? 500;
    this.details = details;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
