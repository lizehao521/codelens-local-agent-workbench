/**
 * P5′ 跨代判决接入 adapter
 *
 * 职责（强化"新旧口径统一消费"维）：
 *   1. 把跨代四值判决（improved/not_improved/undecidable/refused）收窄映射到 RsiVerdict 六态；
 *   2. 把 CrossGenerationVerdictResult 序列化为字段顺序稳定、可 JSON 往返、无 undefined 泄漏的 plain object（新判决可序列化）；
 *   3. 把旧 RsiBridgeResult 适配为同一消费形态（旧输出可消费）。
 *
 * 硬约束：strict 无 any；import 用 .js；纯函数，不读库不写文件；只新增文件、不改既有生产语义。
 */

import type {
  CrossGenerationVerdict,
  CrossGenerationVerdictResult,
} from './cross-generation-verdict.js';
import type { RsiVerdict } from './iteration-gate.js';
import type { RsiBridgeResult } from './rsi-bridge.service.js';
import type { RsiVerdictState } from './rules-contract.js';

export interface SerializedMetricDelta {
  readonly [key: string]: unknown;
}

export interface SerializedEvidenceTransitionSummary {
  readonly [key: string]: unknown;
}

export interface SerializedCrossGenerationVerdict {
  readonly verdict: CrossGenerationVerdict;
  readonly rulesVersion: string;
  readonly reason: string;
  readonly errorCode?: CrossGenerationVerdictResult['errorCode'];
  readonly primary?: SerializedMetricDelta;
  readonly guards: readonly SerializedMetricDelta[];
  readonly diagnostics: readonly SerializedMetricDelta[];
  readonly evidenceTransition?: SerializedEvidenceTransitionSummary;
}

export interface UnifiedRsiConsumption {
  readonly state: RsiVerdictState;
  readonly verdict: RsiVerdict;
  readonly source: 'legacy_bridge' | 'cross_generation';
  readonly reason: string;
  readonly reasons: readonly string[];
  readonly exitCode: number | null;
  readonly metrics: RsiBridgeResult['metrics'];
  readonly reportRaw: string;
  readonly ledgerPath: string;
  readonly serializedVerdict?: SerializedCrossGenerationVerdict;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Cross-generation verdict contains a non-finite number.');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item));
  }
  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) {
        clone[key] = cloneJsonValue(item);
      }
    }
    return clone;
  }
  throw new TypeError('Cross-generation verdict contains a non-JSON value.');
}

function cloneMetricDelta(value: CrossGenerationVerdictResult['primary']): SerializedMetricDelta {
  if (value === undefined) {
    throw new TypeError('Metric delta is required.');
  }
  const cloned = cloneJsonValue(value);
  if (!isRecord(cloned)) {
    throw new TypeError('Metric delta must serialize to an object.');
  }
  return cloned;
}

function cloneEvidenceTransition(
  value: CrossGenerationVerdictResult['evidenceTransition'],
): SerializedEvidenceTransitionSummary {
  if (value === undefined) {
    throw new TypeError('Evidence transition is required.');
  }
  const cloned = cloneJsonValue(value);
  if (!isRecord(cloned)) {
    throw new TypeError('Evidence transition must serialize to an object.');
  }
  return cloned;
}

export function toRsiVerdict(input: CrossGenerationVerdictResult): RsiVerdict {
  switch (input.verdict) {
    case 'improved':
      return 'improved';
    case 'not_improved':
      return 'not_improved';
    case 'undecidable':
      return 'undecidable';
    case 'refused':
      return 'refused';
    default: {
      const exhaustive: never = input.verdict;
      throw new TypeError(`Unsupported cross-generation verdict: ${String(exhaustive)}`);
    }
  }
}

export function serializeCrossGenerationVerdict(
  result: CrossGenerationVerdictResult,
): SerializedCrossGenerationVerdict {
  const serialized: {
    verdict: CrossGenerationVerdict;
    rulesVersion: string;
    reason: string;
    errorCode?: CrossGenerationVerdictResult['errorCode'];
    primary?: SerializedMetricDelta;
    guards: readonly SerializedMetricDelta[];
    diagnostics: readonly SerializedMetricDelta[];
    evidenceTransition?: SerializedEvidenceTransitionSummary;
  } = {
    verdict: result.verdict,
    rulesVersion: result.rulesVersion,
    reason: result.reason,
    guards: result.guards.map((guard) => cloneMetricDelta(guard)),
    diagnostics: result.diagnostics.map((diagnostic) => cloneMetricDelta(diagnostic)),
  };

  if (result.errorCode !== undefined) {
    serialized.errorCode = result.errorCode;
  }
  if (result.primary !== undefined) {
    serialized.primary = cloneMetricDelta(result.primary);
  }
  if (result.evidenceTransition !== undefined) {
    serialized.evidenceTransition = cloneEvidenceTransition(result.evidenceTransition);
  }
  return serialized;
}

export function adaptCrossGenerationVerdict(
  result: CrossGenerationVerdictResult,
): UnifiedRsiConsumption {
  const verdict = toRsiVerdict(result);
  return {
    state: verdict,
    verdict,
    source: 'cross_generation',
    reason: result.reason,
    reasons: [result.reason],
    exitCode: null,
    metrics: undefined,
    reportRaw: JSON.stringify(serializeCrossGenerationVerdict(result)),
    ledgerPath: '',
    serializedVerdict: serializeCrossGenerationVerdict(result),
  };
}

export function adaptLegacyBridgeResult(result: RsiBridgeResult): UnifiedRsiConsumption {
  return {
    state: result.state,
    verdict: result.state,
    source: 'legacy_bridge',
    reason: result.reasons[0] ?? '',
    reasons: [...result.reasons],
    exitCode: result.exitCode,
    metrics: result.metrics?.map((metric) => ({ ...metric })),
    reportRaw: result.reportRaw,
    ledgerPath: result.ledgerPath,
  };
}
