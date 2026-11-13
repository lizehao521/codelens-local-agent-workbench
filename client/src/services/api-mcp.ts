// MCP 连接器端点（自 api.ts 拆出；公开导出面不变）
import type { McpServer } from '../types';
import { get, send } from './api-http';

export async function listMcpServers(): Promise<{ servers: McpServer[] }> {
  return get('/mcp/servers');
}

export async function createMcpServer(input: {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}): Promise<{ server: McpServer }> {
  return send('/mcp/servers', input);
}

export async function patchMcpServer(
  id: string,
  patch: { name?: string; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean },
): Promise<{ server: McpServer }> {
  return send(`/mcp/servers/${encodeURIComponent(id)}`, patch, 'PATCH');
}

export async function deleteMcpServer(id: string): Promise<void> {
  await send(`/mcp/servers/${encodeURIComponent(id)}`, undefined, 'DELETE');
}

export async function connectMcpServer(id: string): Promise<{ status: string; tools: number }> {
  return send(`/mcp/servers/${encodeURIComponent(id)}/connect`, {});
}

export async function disconnectMcpServer(id: string): Promise<{ status: string }> {
  return send(`/mcp/servers/${encodeURIComponent(id)}/disconnect`, {});
}
