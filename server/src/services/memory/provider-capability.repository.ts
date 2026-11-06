/** Provider-capability repository: per-(provider, model) function-calling probes (AC-01). */

import type { Db } from '../../repositories/db.js';

export type ProbeStatus = 'unknown' | 'supported' | 'unsupported' | 'failed';

export interface ProviderCapabilityRow {
  provider: string;
  model: string;
  supports_function_calling: number | null;
  probe_status: ProbeStatus;
  context_window: number | null;
  lightweight_model: string | null;
  tool_choice_values_json: string | null;
  retain_reasoning_content: number;
  require_tool_stream_flag: number;
  explicit_parallel_tool_calls: number;
  probed_at: number | null;
  notes: string | null;
}

export interface UpsertCapabilityInput {
  provider: string;
  model: string;
  supportsFunctionCalling: boolean | null;
  probeStatus: ProbeStatus;
  contextWindow?: number | null;
  lightweightModel?: string | null;
  toolChoiceValues?: string[];
  retainReasoningContent?: boolean;
  requireToolStreamFlag?: boolean;
  explicitParallelToolCalls?: boolean;
  notes?: string | null;
}

export class ProviderCapabilityRepository {
  constructor(private readonly db: Db) {}

  get(provider: string, model: string): ProviderCapabilityRow | undefined {
    return this.db.get<ProviderCapabilityRow>(
      'SELECT * FROM provider_capabilities WHERE provider = ? AND model = ?',
      [provider, model],
    );
  }

  upsert(input: UpsertCapabilityInput): void {
    this.db.run(
      `INSERT INTO provider_capabilities
         (provider, model, supports_function_calling, probe_status, context_window,
          lightweight_model, tool_choice_values_json, retain_reasoning_content,
          require_tool_stream_flag, explicit_parallel_tool_calls, probed_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, model) DO UPDATE SET
         supports_function_calling = excluded.supports_function_calling,
         probe_status = excluded.probe_status,
         context_window = excluded.context_window,
         lightweight_model = excluded.lightweight_model,
         tool_choice_values_json = excluded.tool_choice_values_json,
         retain_reasoning_content = excluded.retain_reasoning_content,
         require_tool_stream_flag = excluded.require_tool_stream_flag,
         explicit_parallel_tool_calls = excluded.explicit_parallel_tool_calls,
         probed_at = excluded.probed_at,
         notes = excluded.notes`,
      [
        input.provider, input.model,
        input.supportsFunctionCalling === null ? null : input.supportsFunctionCalling ? 1 : 0,
        input.probeStatus,
        input.contextWindow ?? null,
        input.lightweightModel ?? null,
        input.toolChoiceValues ? JSON.stringify(input.toolChoiceValues) : null,
        input.retainReasoningContent ? 1 : 0,
        input.requireToolStreamFlag ? 1 : 0,
        input.explicitParallelToolCalls ? 1 : 0,
        Date.now(),
        input.notes ?? null,
      ],
    );
  }

  list(): ProviderCapabilityRow[] {
    return this.db.all<ProviderCapabilityRow>(
      'SELECT * FROM provider_capabilities ORDER BY probed_at DESC',
    );
  }
}
