/**
 * Channel router (AC-01): capability probing (per provider+model, cached in
 * provider_capabilities), channel selection, and runtime degradation.
 *
 * Probe lifecycle: cached row wins → otherwise probe with a fake tool → persist
 * three-state outcome (supported / unsupported / failed). `failed` is NOT cached
 * as unsupported: a network blip must not permanently downgrade a model.
 */

import type { OpenAICompatibleAdapter, ProbeOutcome } from '../../providers/openai-compatible.adapter.js';
import { capabilitiesFor } from '../../providers/capabilities.js';
import type { ProviderCapabilities } from '../../types/index.js';
import type { ProviderCapabilityRepository } from '../memory/provider-capability.repository.js';

export type ChannelMode = 'auto' | 'native' | 'react';
export type Channel = 'native' | 'react';

export interface ChannelDecision {
  channel: Channel;
  degraded: boolean;
  degradedReason: string | null;
  capabilities: ProviderCapabilities;
}

export class ChannelRouter {
  constructor(
    private readonly adapter: OpenAICompatibleAdapter,
    private readonly capabilities: ProviderCapabilityRepository,
  ) {}

  /** Static capabilities merged with any probed row (probe wins). */
  resolveCapabilities(provider: string, model: string): ProviderCapabilities {
    const base = capabilitiesFor(provider);
    const row = this.capabilities.get(provider, model);
    if (!row) return base;
    let toolChoiceValues = base.toolChoiceValues;
    if (row.tool_choice_values_json) {
      try {
        toolChoiceValues = JSON.parse(row.tool_choice_values_json) as ProviderCapabilities['toolChoiceValues'];
      } catch {
        // keep static defaults
      }
    }
    return {
      nativeTools: row.supports_function_calling === null ? base.nativeTools : row.supports_function_calling === 1,
      toolChoiceValues,
      contextWindow: row.context_window ?? base.contextWindow,
      retainReasoningContent: row.retain_reasoning_content === 1,
      requireToolStreamFlag: row.require_tool_stream_flag === 1,
      explicitParallelToolCalls: row.explicit_parallel_tool_calls === 1,
      // 静态 provider 属性（NVIDIA 拒绝 system 角色），不随探测变化，始终回落 base。
      supportsSystemRole: base.supportsSystemRole,
    };
  }

  /**
   * Probes (or reuses) the capability row for (provider, model).
   * Trigger points: model switch, or missing row — never every turn.
   *
   * `signal` 是 run 级取消信号：等待首事件期间用户中止 / 服务关闭时，探测请求
   * 必须随之中止，而不是继续白跑到上游超时再写回能力表（R5 实测 4,982 ms）。
   */
  async probe(
    provider: string,
    model: string,
    apiKey: string,
    baseUrl: string,
    signal?: AbortSignal,
  ): Promise<{
    supports: boolean;
    probed: boolean;
    status: 'supported' | 'unsupported' | 'failed' | 'cached' | 'cancelled';
  }> {
    const cached = this.capabilities.get(provider, model);
    if (cached && (cached.probe_status === 'supported' || cached.probe_status === 'unsupported')) {
      return { supports: cached.probe_status === 'supported', probed: false, status: 'cached' };
    }
    // 已取消：不发起探测，也不写能力表（取消不是能力结论）。
    if (signal?.aborted) {
      return { supports: capabilitiesFor(provider).nativeTools, probed: false, status: 'cancelled' };
    }
    const outcome: ProbeOutcome = await this.adapter.probeToolSupport(
      {
        baseUrl,
        apiKey,
        model,
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        maxTokens: 16,
        stream: false,
      },
      signal,
    );
    // 探测被取消：同样不落库。把 abort 缓存成 failed/supported 都会污染后续决策。
    if (outcome.status === 'cancelled') {
      return { supports: capabilitiesFor(provider).nativeTools, probed: false, status: 'cancelled' };
    }
    const caps = capabilitiesFor(provider);
    if (outcome.status === 'supported') {
      this.capabilities.upsert({
        provider,
        model,
        supportsFunctionCalling: true,
        probeStatus: 'supported',
        contextWindow: caps.contextWindow,
        toolChoiceValues: caps.toolChoiceValues,
        retainReasoningContent: caps.retainReasoningContent,
        requireToolStreamFlag: caps.requireToolStreamFlag,
        explicitParallelToolCalls: caps.explicitParallelToolCalls,
        notes: `探测通过：${outcome.evidence}`,
      });
      return { supports: true, probed: true, status: 'supported' };
    }
    if (outcome.status === 'unsupported') {
      this.capabilities.upsert({
        provider,
        model,
        supportsFunctionCalling: false,
        probeStatus: 'unsupported',
        contextWindow: caps.contextWindow,
        toolChoiceValues: caps.toolChoiceValues,
        retainReasoningContent: caps.retainReasoningContent,
        requireToolStreamFlag: caps.requireToolStreamFlag,
        explicitParallelToolCalls: caps.explicitParallelToolCalls,
        notes: outcome.evidence === 'tools_param_rejected' ? 'provider 拒绝 tools 参数' : '模型返回纯文本',
      });
      return { supports: false, probed: true, status: 'unsupported' };
    }
    // failed: cache as failed (not unsupported), keep static defaults for the decision.
    this.capabilities.upsert({
      provider,
      model,
      supportsFunctionCalling: null,
      probeStatus: 'failed',
      contextWindow: caps.contextWindow,
      toolChoiceValues: caps.toolChoiceValues,
      notes: `探测失败：${outcome.detail}`,
    });
    return { supports: caps.nativeTools, probed: true, status: 'failed' };
  }

  /** Chooses the channel for a request; auto follows the probe result. */
  async decide(
    mode: ChannelMode,
    provider: string,
    model: string,
    apiKey: string,
    baseUrl: string,
    signal?: AbortSignal,
  ): Promise<ChannelDecision> {
    const capabilities = this.resolveCapabilities(provider, model);
    if (mode === 'native') {
      return { channel: 'native', degraded: false, degradedReason: null, capabilities };
    }
    if (mode === 'react') {
      return { channel: 'react', degraded: false, degradedReason: null, capabilities };
    }
    const probe = await this.probe(provider, model, apiKey, baseUrl, signal);
    // 取消不是“探测未通过”：别把取消写进 degradedReason，run 会立刻终止。
    if (probe.status === 'cancelled') {
      return { channel: capabilities.nativeTools ? 'native' : 'react', degraded: false, degradedReason: null, capabilities };
    }
    if (probe.supports) {
      return { channel: 'native', degraded: false, degradedReason: null, capabilities };
    }
    return {
      channel: 'react',
      degraded: true,
      degradedReason:
        probe.status === 'unsupported'
          ? '该模型不支持原生 function calling，已切换提示词解析模式'
          : '能力探测未通过，暂时使用提示词解析模式',
      capabilities,
    };
  }

  /**
   * Runtime degradation: a native turn that fails because the provider rejects
   * the tools parameter (400 naming tools/function) flips to ReAct.
   */
  static shouldDegrade(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /400/.test(message) && /tool|function/i.test(message);
  }
}
