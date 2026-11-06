/**
 * Providers controller: provider/model catalogue with merged capabilities
 * (static defaults + probed rows), and the probe results themselves (AC-01).
 */

import type { Request, Response } from 'express';
import { listProviders } from '../providers/registry.js';
import { capabilitiesFor, limitsFor } from '../providers/capabilities.js';
import type { ProviderCapabilityRow } from '../services/memory/provider-capability.repository.js';
import type { ModelSyncService } from '../services/model-sync/model-sync.service.js';

export class ProvidersController {
  constructor(
    private readonly capabilities: { list(): ProviderCapabilityRow[] },
    private readonly modelSync?: Pick<ModelSyncService, 'status' | 'recentLogs'>,
  ) {}

  list(_req: Request, res: Response): void {
    const probed = new Map<string, ProviderCapabilityRow>();
    for (const row of this.capabilities.list()) probed.set(`${row.provider}:${row.model}`, row);
    const providers = listProviders().map((provider) => {
      const defaults = capabilitiesFor(provider.id);
      const models = provider.models.map((model) => {
        const row = probed.get(`${provider.id}:${model.id}`);
        const synced = model.capabilities;
        const baseCaps = row
          ? {
              nativeTools: row.supports_function_calling === 1,
              toolChoiceValues: row.tool_choice_values_json
                ? (JSON.parse(row.tool_choice_values_json) as string[])
                : defaults.toolChoiceValues,
              contextWindow: row.context_window ?? defaults.contextWindow,
              retainReasoningContent: row.retain_reasoning_content === 1,
              requireToolStreamFlag: row.require_tool_stream_flag === 1,
              explicitParallelToolCalls: row.explicit_parallel_tool_calls === 1,
            }
          : defaults;
        const caps = {
          nativeTools: synced?.function_calling ?? baseCaps.nativeTools,
          toolChoiceValues: baseCaps.toolChoiceValues,
          contextWindow: synced?.context_window ?? baseCaps.contextWindow,
          retainReasoningContent: baseCaps.retainReasoningContent,
          requireToolStreamFlag: baseCaps.requireToolStreamFlag,
          explicitParallelToolCalls: baseCaps.explicitParallelToolCalls,
        };
        // 调用限制：模型级同步 limits 优先，回落 provider 级默认；null = 上游未标注
        const defLimits = limitsFor(provider.id);
        const syncLimits = model.limits ?? {};
        const limits = {
          maxOutputTokens: syncLimits.maxOutputTokens ?? defLimits.maxOutputTokens,
          rateLimitRpm: syncLimits.rateLimitRpm ?? defLimits.rateLimitRpm,
          rateLimitTpm: syncLimits.rateLimitTpm ?? defLimits.rateLimitTpm,
          maxConcurrent: syncLimits.maxConcurrent ?? defLimits.maxConcurrent,
        };
        return {
          id: model.id,
          name: model.name,
          capabilities: caps,
          limits,
          probeStatus: row?.probe_status ?? 'unknown',
        };
      });
      return { ...provider, models };
    });
    res.json({ providers });
  }

  /** GET /api/v1/providers/sync-status —— 最近同步状态 + 最近日志。 */
  syncStatus(_req: Request, res: Response): void {
    const status = this.modelSync?.status() ?? {
      lastRunAt: null, lastStatus: 'never' as const, lastError: null,
      lastProviderCount: null, lastModelCount: null, sourceUrl: '',
    };
    const recentLogs = this.modelSync?.recentLogs(10) ?? [];
    res.json({ sync: status, recentLogs });
  }

  capabilitiesList(_req: Request, res: Response): void {
    const capabilities = this.capabilities.list().map((row) => ({
      provider: row.provider,
      model: row.model,
      supportsFunctionCalling: row.supports_function_calling === 1,
      probeStatus: row.probe_status,
      contextWindow: row.context_window,
      lightweightModel: row.lightweight_model,
      probedAt: row.probed_at,
      notes: row.notes,
    }));
    res.json({ capabilities });
  }
}
