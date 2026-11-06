// 请求构造纯函数（AUDIT-006 修复）：taskKind 真正进入请求体，且可对偶测试。
import type { AgentStreamRequest, Settings, Task } from '../types';

export const TASK_MODES: Array<{ value: Task; label: string }> = [
  { value: 'analyze', label: '分析' },
  { value: 'explain', label: '解释' },
  { value: 'debug', label: '调试' },
  { value: 'optimize', label: '优化' },
];

export function buildAgentStreamRequest(
  settings: Settings,
  message: string,
  sessionId: string,
  patch?: Partial<AgentStreamRequest>,
): AgentStreamRequest {
  const request: AgentStreamRequest = {
    sessionId,
    provider: settings.provider,
    model: settings.model,
    message,
    channelMode: settings.channelMode ?? 'auto',
    maxIterations: 12,
    temperature: 0.3,
    maxTokens: 2048,
  };
  if (settings.apiKey.trim()) request.apiKey = settings.apiKey.trim();
  // 自定义 Provider 的 Base URL 必须随请求透传——服务端 resolveBaseUrl 仅认请求内的值。
  if (settings.customBaseUrl?.trim()) request.customBaseUrl = settings.customBaseUrl.trim();
  return { ...request, ...patch };
}

/**
 * AC-10「从某步重跑」的请求体 patch（AUDIT-008 修复）。
 * 携带该步原参数作为 overrideArguments；无参数时仅 resumeFromCallId。
 */
export function rerunFromPatch(
  callId: string,
  overrideArguments?: Record<string, unknown>,
): Partial<AgentStreamRequest> {
  return overrideArguments === undefined
    ? { resumeFromCallId: callId }
    : { resumeFromCallId: callId, overrideArguments };
}