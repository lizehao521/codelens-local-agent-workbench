/**
 * 跨代判决：输入校验与指标比较（内部实现层，不对外导出）。
 * 从 cross-generation-verdict.ts 拆出（结构棘轮 ≤300 行）。
 */

import {
  CrossGenerationContractError,
  EVIDENCE_LEVELS,
  assertEvidenceTransition,
  evaluateEvidenceTransition,
  evidenceLevelIndex,
  validateEvidence,
} from './cross-generation-contract.js';
import type {
  EvidenceLevel,
  GenerationEvidence,
  MetricDefinition,
  MetricDirection,
} from './cross-generation-contract.js';
import {
  CROSS_GENERATION_VERDICT_RULES_VERSION,
  CrossGenerationVerdictError,
} from './cross-generation-verdict.types.js';
import type {
  CrossGenerationVerdict,
  CrossGenerationVerdictErrorCode,
  CrossGenerationVerdictInput,
  CrossGenerationVerdictResult,
  EvidenceTransitionSummary,
  GenerationIndicators,
  IndicatorValue,
  MetricDelta,
} from './cross-generation-verdict.types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isEvidenceLevel(value: unknown): value is EvidenceLevel {
  return typeof value === 'string' && (EVIDENCE_LEVELS as readonly string[]).includes(value);
}

export function isMetricDirection(value: unknown): value is MetricDirection {
  return value === 'higher_is_better' || value === 'lower_is_better';
}

export function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CrossGenerationVerdictError(
      'INVALID_INDICATOR_VALUE',
      `${label} must be a finite number.`,
    );
  }
  return value;
}

export function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CrossGenerationVerdictError('INVALID_INPUT', `${label} must be a non-empty string.`);
  }
  return value;
}

export function validateDefinition(definition: MetricDefinition, label: string): void {
  if (!isRecord(definition)) {
    throw new CrossGenerationVerdictError('INVALID_INPUT', `${label} must be a metric definition.`);
  }
  requireNonEmptyString(definition.id, `${label}.id`);
  requireNonEmptyString(definition.definitionVersion, `${label}.definitionVersion`);
  requireNonEmptyString(definition.unit, `${label}.unit`);
  if (!isMetricDirection(definition.direction)) {
    throw new CrossGenerationVerdictError('INVALID_INPUT', `${label}.direction is invalid.`);
  }
}

export function validateIndicator(indicator: IndicatorValue, label: string): void {
  if (!isRecord(indicator)) {
    throw new CrossGenerationVerdictError('INVALID_INPUT', `${label} must be an indicator.`);
  }
  validateDefinition(indicator.definition, `${label}.definition`);
  requireFiniteNumber(indicator.value, `${label}.value`);
}

export function validateUniqueIndicators(
  indicators: readonly IndicatorValue[],
  label: string,
  duplicateCode: 'DUPLICATE_INDICATOR' | 'DUPLICATE_GUARD',
): void {
  const ids = new Set<string>();
  for (const [index, indicator] of indicators.entries()) {
    validateIndicator(indicator, `${label}[${index}]`);
    if (ids.has(indicator.definition.id)) {
      throw new CrossGenerationVerdictError(
        duplicateCode,
        `${label} contains duplicate metric ${indicator.definition.id}.`,
      );
    }
    ids.add(indicator.definition.id);
  }
}

export function validateIndicators(indicators: GenerationIndicators, label: string): void {
  if (!isRecord(indicators)) {
    throw new CrossGenerationVerdictError('INVALID_INPUT', `${label} must contain indicators.`);
  }
  validateIndicator(indicators.primary, `${label}.primary`);
  const guards = indicators.guards ?? [];
  const diagnostics = indicators.diagnostics ?? [];
  if (!Array.isArray(guards) || !Array.isArray(diagnostics)) {
    throw new CrossGenerationVerdictError('INVALID_INPUT', `${label} metric collections must be arrays.`);
  }
  validateUniqueIndicators(guards, `${label}.guards`, 'DUPLICATE_GUARD');
  validateUniqueIndicators(diagnostics, `${label}.diagnostics`, 'DUPLICATE_INDICATOR');
  if (guards.some((guard) => guard.definition.id === indicators.primary.definition.id)) {
    throw new CrossGenerationVerdictError(
      'PRIMARY_IS_GUARD',
      'The primary objective cannot also be a guard.',
    );
  }
}

export function validateEvidenceLevel(evidence: GenerationEvidence, label: string): void {
  if (!isRecord(evidence) || !isEvidenceLevel(evidence.level)) {
    throw new CrossGenerationVerdictError(
      'MISSING_EVIDENCE_LEVEL',
      `${label} must contain a known evidence level.`,
    );
  }
  try {
    validateEvidence(evidence);
  } catch (error: unknown) {
    if (error instanceof CrossGenerationContractError) {
      throw new CrossGenerationVerdictError('INVALID_EVIDENCE', `${label}: ${error.message}`);
    }
    throw error;
  }
}

export function validateInput(input: CrossGenerationVerdictInput): void {
  if (!isRecord(input)) {
    throw new CrossGenerationVerdictError('INVALID_INPUT', 'A verdict input is required.');
  }
  if (input.rulesVersion !== CROSS_GENERATION_VERDICT_RULES_VERSION) {
    throw new CrossGenerationVerdictError(
      'INVALID_INPUT',
      `rulesVersion must be ${CROSS_GENERATION_VERDICT_RULES_VERSION}.`,
    );
  }
  if (!isRecord(input.previous) || !isRecord(input.next)) {
    throw new CrossGenerationVerdictError(
      'INVALID_INPUT',
      'Both previous and next generations are required.',
    );
  }
  validateIndicators(input.previous.indicators, 'previous.indicators');
  validateIndicators(input.next.indicators, 'next.indicators');
  validateEvidenceLevel(input.previous.evidence, 'previous.evidence');
  validateEvidenceLevel(input.next.evidence, 'next.evidence');
}

export function sameDefinition(left: MetricDefinition, right: MetricDefinition): boolean {
  return (
    left.id === right.id &&
    left.definitionVersion === right.definitionVersion &&
    left.direction === right.direction &&
    left.unit === right.unit
  );
}

export function compareMetric(previous: IndicatorValue, next: IndicatorValue): MetricDelta {
  const direction = previous.definition.direction;
  const delta = next.value - previous.value;
  const improved =
    direction === 'higher_is_better' ? next.value > previous.value : next.value < previous.value;
  const regressed =
    direction === 'higher_is_better' ? next.value < previous.value : next.value > previous.value;
  return {
    id: previous.definition.id,
    direction,
    previous: previous.value,
    next: next.value,
    delta,
    improved,
    regressed,
  };
}

export function findById(indicators: readonly IndicatorValue[], id: string): IndicatorValue | undefined {
  return indicators.find((indicator) => indicator.definition.id === id);
}

export function compareCollection(
  previous: readonly IndicatorValue[],
  next: readonly IndicatorValue[],
): MetricDelta[] {
  const deltas: MetricDelta[] = [];
  for (const previousIndicator of previous) {
    const nextIndicator = findById(next, previousIndicator.definition.id);
    if (nextIndicator === undefined || !sameDefinition(previousIndicator.definition, nextIndicator.definition)) {
      continue;
    }
    deltas.push(compareMetric(previousIndicator, nextIndicator));
  }
  return deltas;
}

export function primaryDefinitionError(
  previous: MetricDefinition,
  next: MetricDefinition,
): CrossGenerationVerdictErrorCode | undefined {
  if (previous.id !== next.id || previous.definitionVersion !== next.definitionVersion) {
    return 'PRIMARY_DEFINITION_CHANGED';
  }
  if (previous.direction !== next.direction) {
    return 'PRIMARY_DIRECTION_CHANGED';
  }
  if (previous.unit !== next.unit) {
    return 'PRIMARY_UNIT_CHANGED';
  }
  return undefined;
}

export function evidenceSummary(from: EvidenceLevel, to: EvidenceLevel): EvidenceTransitionSummary {
  const transition = evaluateEvidenceTransition(from, to);
  return {
    from,
    to,
    fromIndex: evidenceLevelIndex(from),
    toIndex: evidenceLevelIndex(to),
    ok: transition.ok,
    ...(transition.errorCode === undefined ? {} : { errorCode: transition.errorCode }),
  };
}

export function result(
  verdict: CrossGenerationVerdict,
  reason: string,
  guards: readonly MetricDelta[],
  diagnostics: readonly MetricDelta[],
  options: {
    readonly errorCode?: CrossGenerationVerdictErrorCode;
    readonly primary?: MetricDelta;
    readonly evidenceTransition?: EvidenceTransitionSummary;
  } = {},
): CrossGenerationVerdictResult {
  return {
    verdict,
    rulesVersion: CROSS_GENERATION_VERDICT_RULES_VERSION,
    reason,
    guards,
    diagnostics,
    ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
    ...(options.primary === undefined ? {} : { primary: options.primary }),
    ...(options.evidenceTransition === undefined
      ? {}
      : { evidenceTransition: options.evidenceTransition }),
  };
}

export function mapEvidenceError(error: unknown): CrossGenerationVerdictError {
  if (error instanceof CrossGenerationContractError) {
    if (error.code === 'EVIDENCE_REGRESSION' || error.code === 'EVIDENCE_LEVEL_SKIPPED') {
      return new CrossGenerationVerdictError(error.code, error.message);
    }
    return new CrossGenerationVerdictError('INVALID_EVIDENCE_TRANSITION', error.message);
  }
  throw error;
}
