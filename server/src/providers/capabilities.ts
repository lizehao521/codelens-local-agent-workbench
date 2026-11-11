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
    /**
     * 32000 → 128000（2026-11-11）。
     *
     * 原值不是测出来的，是「自定义端点什么都有可能」时的保守下界。代价很实在：
     * token 预算是 `contextWindow × AGENT_TOKEN_BUDGET_FACTOR`，32000 × 2 = 64000。
     * 自我升级那类「写一个 200 行新工具」的任务，光任务书就 8k，再读两次文件就可能
     * 撞上 64k 硬顶 —— 实测有一轮 9 次工具调用全是读，token 68454/64000 被判
     * budget_exhausted，一次写入都没发生。那看起来像「模型不会干活」，实际是
     * 预算把它掐在半路。
     *
     * 为什么取 128000：本项目的自定义端点实测 20 万字符（约 10 万+ token）的
     * prompt 正常返回；DeepSeek/GLM/Qwen 这一代主流模型都是 128k 起。
     * 仍可能高估更小的端点——那种情况由 providers 表按行覆盖
     * （`row.context_window ?? base.contextWindow`），不必用全局默认替所有人保守。
     */
    contextWindow: 128000,
    retainReasoningContent: false,
    requireToolStreamFlag: false,
    explicitParallelToolCalls: false,
  },
};

export function capabilitiesFor(providerId: string): ProviderCapabilities {
  return CAPABILITIES[providerId] ?? CAPABILITIES.custom!;
}
