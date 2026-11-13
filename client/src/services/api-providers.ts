// 健康与 Provider 端点（自 api.ts 拆出；公开导出面不变）
import type { Provider } from '../types';
import { ApiError, get } from './api-http';

/** GET /api/health —— StatusBar 连接状态点（含 db/mcp/sandbox） */
export async function getHealth(): Promise<{
  status: string;
  db: { ok: boolean };
  mcp: { servers: number; healthy: number };
}> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new ApiError(`HTTP_${res.status}`, '健康检查失败', res.status);
  return (await res.json()) as {
    status: string;
    db: { ok: boolean };
    mcp: { servers: number; healthy: number };
  };
}

/** GET /api/v1/providers —— provider 与模型列表（不含 Key） */
export async function getProviders(): Promise<Provider[]> {
  const data = await get<{ providers?: Provider[] }>('/providers');
  return data.providers ?? [];
}

/** GET /api/v1/providers/capabilities —— 能力探测合并视图（AC-01） */
export async function getProviderCapabilities(): Promise<{
  capabilities: Array<{
    provider: string;
    model: string;
    supportsFunctionCalling: boolean | null;
    probeStatus: string;
    contextWindow: number | null;
    lightweightModel: string | null;
    probedAt: number | null;
    notes: string | null;
  }>;
}> {
  return get('/providers/capabilities');
}

/** GET /api/v1/providers/sync-status —— 最近一次上游模型同步状态与最近日志 */
export async function getProviderSyncStatus(): Promise<{
  sync: {
    lastRunAt: number | null;
    lastStatus: string;
    lastError: string | null;
    lastProviderCount: number | null;
    lastModelCount: number | null;
    sourceUrl: string;
  };
  recentLogs: Array<{
    id: number;
    occurred_at: number;
    status: string;
    attempt: number;
    message: string;
    detail: string | null;
    source_url: string;
  }>;
}> {
  return get('/providers/sync-status');
}
