/**
 * Tool error kinds — LOCKED 10-value enum (spec section 4.2.6, ADR-023).
 * Deliberate changes from the earlier 9-value proposal:
 *   - `payload_too_large` removed: oversize results use tool_result.truncated,
 *     oversize request bodies are HTTP 413 — neither is a tool execution failure.
 *   - `forbidden` merged into `security` (AC-07 wording: "denied by security policy").
 *   - `upstream` added: 5xx/401 retry semantics differ from `network`.
 *   - `circuit_open` added: the 4th call after 3 consecutive failures must return
 *     without any LLM call (AC-08), and it is neutral, not an error.
 * `revised` is NOT here: it only lives in the DB tool_calls.error_kind column
 * for calls superseded by a parameter revision, never in an SSE payload.
 */

export const TOOL_ERROR_KIND = {
  INVALID_ARGS: 'invalid_args',
  NOT_FOUND: 'not_found',
  SECURITY: 'security',
  TIMEOUT: 'timeout',
  RATE_LIMIT: 'rate_limit',
  NETWORK: 'network',
  UPSTREAM: 'upstream',
  MCP: 'mcp',
  CIRCUIT_OPEN: 'circuit_open',
  INTERNAL: 'internal',
} as const;

export type ToolErrorKind = (typeof TOOL_ERROR_KIND)[keyof typeof TOOL_ERROR_KIND];

/** Every kind the UI lookup table covers (frontend must render each without crashing). */
export const UI_TABLE_KINDS: readonly ToolErrorKind[] = [
  TOOL_ERROR_KIND.INVALID_ARGS,
  TOOL_ERROR_KIND.NOT_FOUND,
  TOOL_ERROR_KIND.SECURITY,
  TOOL_ERROR_KIND.TIMEOUT,
  TOOL_ERROR_KIND.RATE_LIMIT,
  TOOL_ERROR_KIND.NETWORK,
  TOOL_ERROR_KIND.UPSTREAM,
  TOOL_ERROR_KIND.MCP,
  TOOL_ERROR_KIND.CIRCUIT_OPEN,
  TOOL_ERROR_KIND.INTERNAL,
];

/** Kinds that must NOT consume the task retry budget (AC-08 second clause). */
export const NON_BUDGET_KINDS: readonly ToolErrorKind[] = [
  TOOL_ERROR_KIND.INVALID_ARGS,
  TOOL_ERROR_KIND.NOT_FOUND,
  TOOL_ERROR_KIND.SECURITY,
  TOOL_ERROR_KIND.CIRCUIT_OPEN,
  TOOL_ERROR_KIND.INTERNAL,
];

/** Kinds the executor may auto-retry once (idempotent methods only for network). */
export const RETRYABLE_KINDS: readonly ToolErrorKind[] = [
  TOOL_ERROR_KIND.TIMEOUT,
  TOOL_ERROR_KIND.RATE_LIMIT,
  TOOL_ERROR_KIND.NETWORK,
  TOOL_ERROR_KIND.UPSTREAM,
  TOOL_ERROR_KIND.MCP,
];

export function isToolErrorKind(value: unknown): value is ToolErrorKind {
  return typeof value === 'string' && Object.values(TOOL_ERROR_KIND).includes(value as ToolErrorKind);
}

/** Unknown kinds fall back to `internal` so the UI renders a generic card, never crashes. */
export function uiRenderableKind(kind: ToolErrorKind): ToolErrorKind {
  return UI_TABLE_KINDS.includes(kind) ? kind : TOOL_ERROR_KIND.INTERNAL;
}
