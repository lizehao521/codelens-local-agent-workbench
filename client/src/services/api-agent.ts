// Agent 运行控制端点（自 api.ts 拆出；公开导出面不变）
import { get, send } from './api-http';

/**
 * POST /api/v1/agent/abort —— 服务端直停当前会话的运行（P1-6）。
 * 本地 abort() 经「断开→res.close」也能停，但该端点不等 TCP 关闭传播到
 * AbortRegistry，且跨标签页（本页无活跃 controller）时是唯一入口。
 * aborted=false 表示该会话当前没有在跑的任务（幂等无害）。
 */
export async function abortAgentRun(sessionId: string): Promise<{ ok: boolean; aborted: boolean }> {
  return send('/agent/abort', { sessionId });
}

/** 兜底 Key 试用/预算状态（按请求 IP）。 */
export interface TrialStatus {
  enabled: boolean;
  trialModeEnabled: boolean;
  serverKeyConfigured: boolean;
  dailyLimit: number | null;
  usedRuns: number;
  remainingRuns: number | null;
  perTaskTokenLimit: number;
  budgetExceeded: boolean;
  budgetReason: 'trial_exhausted' | 'global_budget_exhausted' | 'per_ip_budget_exhausted' | null;
  /** 试用锁定的上游（未启用试用锁定时为 null）。只含地址与模型，不含密钥。 */
  trialUpstream: {
    provider: string;
    model: string;
    baseUrl: string | null;
    /** R4：真实最小生成探测的三态结果（ok / auth_failed / unreachable）。 */
    health: {
      status: 'unknown' | 'ok' | 'auth_failed' | 'unreachable';
      detail: string | null;
      checkedAt: number | null;
      durationMs: number | null;
      tokens: { promptTokens: number; completionTokens: number } | null;
      cached: boolean;
    };
  } | null;
}

/** GET /api/v1/agent/trial-status —— 前端无 Key 引导条据此展示试用剩余次数。 */
export async function getTrialStatus(): Promise<TrialStatus> {
  return get('/agent/trial-status');
}
