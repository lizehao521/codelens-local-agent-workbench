// 工具注册表与审批端点（自 api.ts 拆出；公开导出面不变）
import type { ApprovalSubmitRequest, ToolDefinitionPublic } from '../types';
import { get, send } from './api-http';

/** GET /api/v1/tools —— 双轨名 + 风险分组 */
export async function listTools(): Promise<{
  tools: ToolDefinitionPublic[];
  grouped: Record<'low' | 'medium' | 'high', string[]>;
}> {
  return get('/tools');
}

/** PATCH /api/v1/tools/:name —— 启用 / 禁用 */
export async function patchTool(name: string, enabled: boolean): Promise<{ name: string; enabled: boolean }> {
  return send(`/tools/${encodeURIComponent(name)}`, { enabled }, 'PATCH');
}

// ── 审批（独立端点，不走 SSE 同流） ─────────────────────────

/** POST /api/v1/approvals/:id —— 三值决定（.strict()：body 出现 arguments 一律 400） */
export async function submitApproval(approvalId: string, body: ApprovalSubmitRequest): Promise<{ ok: true }> {
  return send(`/approvals/${encodeURIComponent(approvalId)}`, body);
}

/** POST /api/v1/approvals/:id/revise —— AC-10 改参数重试（唯一可带 arguments 的端点） */
export async function reviseApproval(
  approvalId: string,
  token: string,
  args: Record<string, unknown>,
): Promise<{ ok: true }> {
  return send(`/approvals/${encodeURIComponent(approvalId)}/revise`, { token, arguments: args });
}

/** POST /api/v1/approvals/:id/reissue —— AUDIT-009 续期（重新签发未过期令牌，延长 5 分钟） */
export async function reissueApproval(
  approvalId: string,
  token: string,
): Promise<{ ok: true; approvalId: string; approvalToken: string; expiresAt: number }> {
  return send(`/approvals/${encodeURIComponent(approvalId)}/reissue`, { token });
}
