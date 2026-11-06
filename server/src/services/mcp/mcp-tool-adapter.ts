/**
 * MCP tool adapter: an MCP server tool becomes a ToolDefinition registered under
 * the canonical name `mcp.<serverId>.<toolName>` (dots → underscores on the wire).
 * Handlers proxy callTool through the manager's live client.
 *
 * P2-1: risk used to be hardwired high/hard for EVERY MCP tool — each call
 * demanded a hard human approval, which is exactly the "approval fatigue"
 * AC-03 tells us to avoid, and it flattened read-only lookups together with
 * destructive writes. Grading now follows the server's own MCP annotations:
 *   readOnlyHint=true            → low/none    (cannot modify anything)
 *   destructiveHint=true         → high/hard   (irreversible side effects)
 *   anything else (a plain write) → medium/soft (still gated on every call)
 * An UNANNOTATED tool is a write (medium/soft): it keeps its approval prompt,
 * so lowering the graded tiers never silently removes a gate. Per-tool
 * overrides from the connector page are NOT implemented yet — the baseline
 * here is the single source of truth until they are.
 */

import type { ToolDefinition, JsonSchemaObject } from '../../types/tool.js';
import type { McpManagerService } from './mcp-manager.service.js';

/**
 * One canonical-name segment: lowercase, invalid chars collapse to `_`,
 * must start with a letter (CANONICAL_NAME_RE). Upstream MCP tool names are
 * arbitrary (`get-issue`, `Echo`, `2fast`) — sanitize before they become part
 * of `mcp.<server>.<tool>`, or registration throws.
 */
function sanitizeSegment(segment: string): string {
  const collapsed = segment
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(collapsed) ? collapsed : `t_${collapsed}`;
}

export function canonicalMcpToolName(serverId: string, toolName: string): string {
  return `mcp.${sanitizeSegment(serverId)}.${sanitizeSegment(toolName)}`;
}

/** Validates that the upstream inputSchema fits our draft-07 subset. */
export function toJsonSchemaSubset(input: unknown): JsonSchemaObject | null {
  if (!input || typeof input !== 'object') return null;
  const schema = input as Record<string, unknown>;
  if (schema.type !== undefined && schema.type !== 'object') return null;
  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: schema.additionalProperties === false ? false : true,
    description: typeof schema.description === 'string' ? schema.description : undefined,
  };
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
  /** MCP tool annotations (advisory hints from the server; absent = a write). */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

/**
 * P2-1: baseline risk/approval from the server's annotations. A read-only tool
 * cannot modify anything (no gate); a destructive one is irreversible (hard
 * gate); everything else — including tools that declare nothing — is a write
 * and stays soft-gated. Nothing unannotated ever lands on `none`.
 */
export function gradeMcpRisk(annotations: McpToolInfo['annotations']): { risk: ToolDefinition['risk']; approvalMode: ToolDefinition['approvalMode'] } {
  if (annotations?.readOnlyHint === true) return { risk: 'low', approvalMode: 'none' };
  if (annotations?.destructiveHint === true) return { risk: 'high', approvalMode: 'hard' };
  return { risk: 'medium', approvalMode: 'soft' };
}

/** Builds the registry definition for one MCP tool. */
export function adaptMcpTool(
  serverId: string,
  tool: McpToolInfo,
  manager: McpManagerService,
  timeoutMs = 30000,
): ToolDefinition | null {
  const inputSchema = toJsonSchemaSubset(tool.inputSchema);
  if (!inputSchema) return null; // unsupported schema: ReAct-only, not registered for native
  const canonical = canonicalMcpToolName(serverId, tool.name);
  // A read-only tool is inherently idempotent — that is what makes its
  // timeouts safe to auto-retry (P2-1 retry gate in the executor).
  const idempotent = tool.annotations?.readOnlyHint === true || tool.annotations?.idempotentHint === true;
  const graded = gradeMcpRisk(tool.annotations);
  return {
    name: canonical,
    wireName: canonical.replace(/\./g, '_'),
    displayName: tool.name,
    category: 'mcp',
    description: tool.description ?? `MCP 工具 ${tool.name}（服务器 ${serverId}）`,
    inputSchema,
    timeoutMs,
    risk: graded.risk,
    approvalMode: graded.approvalMode,
    source: 'mcp',
    idempotent,
    maxResultChars: 4000,
    mcpServerId: serverId,
    enabled: () => manager.isConnected(serverId), // AC-12: invisible unless connected
    handler: async (args, ctx) => {
      const connected = manager.isConnected(serverId);
      if (!connected) {
        return {
          ok: false,
          summary: `MCP 服务器 ${serverId} 未连接`,
          error: { code: 'MCP_NOT_CONNECTED', kind: 'mcp', message: `MCP 服务器 ${serverId} 未连接`, retryable: false },
        };
      }
      try {
        const result = await manager.callTool(serverId, tool.name, args, ctx.signal);
        const text = result.content
          .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : JSON.stringify(block)))
          .join('\n');
        return {
          ok: !result.isError,
          summary: text.slice(0, 200) || 'MCP 工具返回空结果',
          data: { text, isError: result.isError },
          error: result.isError
            ? { code: 'MCP_CALL_FAILED', kind: 'mcp', message: text.slice(0, 500), retryable: idempotent }
            : undefined,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          summary: `MCP 调用失败：${message}`,
          error: { code: 'MCP_CALL_FAILED', kind: 'mcp', message: message.slice(0, 500), retryable: idempotent },
        };
      }
    },
  };
}
