// 会话端点（自 api.ts 拆出；公开导出面不变）
import type { SessionDetail, SessionListResponse, ServerSession } from '../types';
import { BASE, parseErrorResponse, send } from './api-http';

/** GET /api/v1/sessions —— 列表（带 X-Device-Token 时只返回本设备会话） */
export async function listSessions(deviceToken?: string | null): Promise<SessionListResponse> {
  const res = await fetch(`${BASE}/sessions?limit=100`, {
    headers: deviceToken ? { 'X-Device-Token': deviceToken } : undefined,
  });
  if (!res.ok) throw await parseErrorResponse(res);
  return (await res.json()) as SessionListResponse;
}

/** POST /api/v1/sessions —— 创建；recoveryCode 只此一次明文 */
export async function createSession(input: {
  provider: string;
  model: string;
  title?: string;
}): Promise<{ session: ServerSession; recoveryCode: string; deviceToken: string }> {
  return send('/sessions', input);
}

/** GET /api/v1/sessions/:id —— 详情（消息 + 工具调用 + 审批） */
export async function getSessionDetail(
  sessionId: string,
  deviceToken?: string | null,
): Promise<SessionDetail> {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}`, {
    headers: deviceToken ? { 'X-Device-Token': deviceToken } : undefined,
  });
  if (!res.ok) throw await parseErrorResponse(res);
  return (await res.json()) as SessionDetail;
}

/** PATCH /api/v1/sessions/:id —— 重命名 / 改模型 */
export async function patchSession(
  sessionId: string,
  patch: { title?: string; model?: string; channelMode?: 'auto' | 'native' | 'react' },
  deviceToken?: string | null,
): Promise<{ session: ServerSession }> {
  return send(`/sessions/${encodeURIComponent(sessionId)}`, patch, 'PATCH', deviceToken);
}

/** DELETE /api/v1/sessions/:id —— 删除（级联） */
export async function deleteSession(sessionId: string, deviceToken?: string | null): Promise<void> {
  await send(`/sessions/${encodeURIComponent(sessionId)}`, undefined, 'DELETE', deviceToken);
}

/** POST /api/v1/sessions/:id/recovery-code —— 重生成（旧码立即失效） */
export async function regenerateRecoveryCode(sessionId: string): Promise<{ recoveryCode: string }> {
  return send(`/sessions/${encodeURIComponent(sessionId)}/recovery-code`, {});
}

/** POST /api/v1/sessions/recover —— 恢复码换回会话（旧码立即失效） */
export async function recoverSession(recoveryCode: string, deviceToken: string): Promise<{
  session: ServerSession;
  deviceToken: string;
}> {
  return send('/sessions/recover', { recoveryCode, deviceToken });
}
