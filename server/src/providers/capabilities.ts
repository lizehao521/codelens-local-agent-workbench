/**
 * Static provider capability table (architecture 5.3). Probed rows in
 * provider_capabilities take precedence; these are the fallback defaults so the
 * platform can decide a channel before the first probe completes.
 */

import type { ProviderCapabilities, ModelLimits } from '../types/index.js';

/**
 * Provider 级调用限制默认值（模型级 limits 可覆盖）。null = 未标注，前端显示「未标注」。
 * 仅作降级兜底；同步目录下发的 limits 优先。
 */
export const LIMITS: Record<string, ModelLimits> = {
  deepseek: { maxOutputTokens: 8192, rateLimitRpm: 60, rateLimitTpm: null, maxConcurrent: 4 },
  zhipu: { maxOutputTokens: 4096, rateLimitRpm: 60, rateLimitTpm: null, maxConcurrent: 4 },
  qwen: { maxOutputTokens: 8192, rateLimitRpm: 120, rateLimitTpm: null, maxConcurrent: 4 },
  moonshot: { maxOutputTokens: 4096, rateLimitRpm: 60, rateLimitTpm: null, maxConcurrent: 3 },
  openai: { maxOutputTokens: 4096, rateLimitRpm: 60, rateLimitTpm: null, maxConcurrent: 4 },
  custom: { maxOutputTokens: null, rateLimitRpm: null, rateLimitTpm: null, maxConcurrent: null },
};

export function limitsFor(providerId: string): ModelLimits {
  return LIMITS[providerId] ?? LIMITS.custom!;
}

export const CAPABILITIES: Record<string, ProviderCapabilities> = {
  deepseek: {
    nativeTools: true,
    toolChoiceValues: ['auto', 'none', 'required', 'named'],
    contextWindow: 65536,
    retainReasoningContent: false,
    requireToolStreamFlag: false,
    explicitParallelToolCalls: false,
  },
  zhipu: {
    nativeTools: true,
    toolChoiceValues: ['auto', 'none', 'required'],
    contextWindow: 128000,
    retainReasoningContent: false,
    requireToolStreamFlag: true, // GLM requires tool_stream
    explicitParallelToolCalls: true,
  },
  qwen: {
    nativeTools: true,
    toolChoiceValues: ['auto', 'none', 'required'],
    contextWindow: 128000,
    retainReasoningContent: false,
    requireToolStreamFlag: false,
    explicitParallelToolCalls: true,
  },
  moonshot: {
    nativeTools: true,
    toolChoiceValues: ['auto', 'none', 'required'],
    contextWindow: 128000,
    retainReasoningContent: true, // thinking models echo reasoning_content
    requireToolStreamFlag: false,
    explicitParallelToolCalls: true,
  },
  openai: {
    nativeTools: true,
    toolChoiceValues: ['auto', 'none', 'required', 'named'],
    contextWindow: 128000,
    retainReasoningContent: false,
    requireToolStreamFlag: false,
    explicitParallelToolCalls: true,
  },
  nvidia: {
    nativeTools: true,
    toolChoiceValues: ['auto', 'none', 'required'],
    contextWindow: 128000,
    retainReasoningContent: true, // Nemotron-3-Ultra 回显 reasoning_content
    requireToolStreamFlag: false,
    explicitParallelToolCalls: false,
    supportsSystemRole: false, // integrate.api.nvidia.com/v1 拒绝 system 角色
  },
  custom: {
    nativeTools: true,
    toolChoiceValues: ['auto', 'none'],
    contextWindow: 32000,
    retainReasoningContent: false,
    requireToolStreamFlag: false,
    explicitParallelToolCalls: false,
  },
};

export function capabilitiesFor(providerId: string): ProviderCapabilities {
  return CAPABILITIES[providerId] ?? CAPABILITIES.custom!;
}
