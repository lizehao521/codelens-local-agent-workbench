// src/services/rsi/cross-generation-verdict.ts
import {
  EVIDENCE_LEVELS,
  CrossGenerationContractError,
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

export const CROSS_GENERATION_VERDICT_RULES_VERSION = 'cross-generation-verdict.v1';

export const CROSS_GENERATION_VERDICTS = [
  'improved',
  'not_improved',
  'undecidable',
  'refused',
] as const;

export type CrossGenerationVerdict = (typeof CROSS_GENERATION_VERDICTS)[number];

export type CrossGenerationVerdictErrorCode =
  | 'MULTIPLE_PRIMARY_OBJECTIVES'
  | 'MISSING_PRIMARY_OBJECTIVE'
  | 'MISSING_EVIDENCE_LEVEL'
  | 'INVALID_EVIDENCE'
  | 'EVIDENCE_REGRESSION'
  | 'EVIDENCE_LEVEL_SKIPPED'
  | 'INVALID_EVIDENCE_TRANSITION'
  | 'MISSING_PRIMARY_METRIC'
  | 'INCOMPARABLE_PRIMARY_METRIC'
  | 'PRIMARY_DEFINITION_CHANGED'
  | 'PRIMARY_DIRECTION_CHANGED'
  | 'PRIMARY_UNIT_CHANGED'
  | 'INVALID_INDICATOR_VALUE'
  | 'DUPLICATE_INDICATOR'
  | 'DUPLICATE_GUARD'
  | 'PRIMARY_IS_GUARD'
  | 'GUARD_DEFINITION_CHANGED'
  | 'MISSING_GUARD_METRIC'
  | 'INVALID_INPUT';

export class CrossGenerationVerdictError extends Error {
  public readonly code: CrossGenerationVerdictErrorCode;

  public constructor(code: CrossGenerationVerdictErrorCode, message: string) {
    super(message);
    this.name = 'CrossGenerationVerdictError';
    this.code = code;
  }
}

export interface IndicatorValue {
  readonly definition: MetricDefinition;
  readonly value: number;
}

export interface GenerationIndicators {
  readonly primary: IndicatorValue;
  readonly guards?: readonly IndicatorValue[];
  readonly diagnostics?: readonly IndicatorValue[];
}

export interface CrossGenerationVerdictInput {
  readonly rulesVersion: string;
  readonly previous: {
    readonly indicators: GenerationIndicators;
    readonly evidence: GenerationEvidence;
  };
  readonly next: {
    readonly indicators: GenerationIndicators;
    readonly evidence: GenerationEvidence;
  };
}

export interface MetricDelta {
  readonly id: string;
  readonly direction: MetricDirection;
  readonly previous: number;
  readonly next: number;
  readonly delta: number;
  readonly improved: boolean;
  readonly regressed: boolean;
}

export interface EvidenceTransitionSummary {
  readonly from: EvidenceLevel;
  readonly to: EvidenceLevel;
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly ok: boolean;
  readonly errorCode?: string;
}

export interface CrossGenerationVerdictResult {
  readonly verdict: CrossGenerationVerdict;
  readonly rulesVersion: string;
  readonly reason: string;
  readonly errorCode?: CrossGenerationVerdictErrorCode;
  readonly primary?: MetricDelta;
  readonly guards: readonly MetricDelta[];
  readonly diagnostics: readonly MetricDelta[];
  readonly evidenceTransition?: EvidenceTransitionSummary;
}

export interface VerdictStateTransition {
  readonly from: CrossGenerationVerdict | 'initial';
  readonly event:
    | 'evaluate'
    | 'primary_strictly_improved'
    | 'primary_not_improved'
    | 'guard_regressed'
    | 'primary_not_comparable'
    | 'multiple_primary_objectives'
    | 'missing_evidence_level'
    | 'invalid_evidence_transition';
  readonly to: CrossGenerationVerdict;
  readonly rule: string;
}

/**
 * Declarative state table. Evaluation is fail-closed: refusal and missing
 * comparability take precedence over every diagnostic observation.
 */
export const VERDICT_STATE_TRANSITIONS: readonly VerdictStateTransition[] = [
  {
    from: 'initial',
    event: 'multiple_primary_objectives',
    to: 'refused',
    rule: 'Exactly one primary objective is required.',
  },
  {
    from: 'initial',
    event: 'missing_evidence_level',
    to: 'refused',
    rule: 'Both generations must carry a known evidence level.',
  },
  {
    from: 'initial',
    event: 'invalid_evidence_transition',
    to: 'refused',
    rule: 'Evidence may advance only one adjacent level and may never regress.',
  },
  {
    from: 'initial',
    event: 'primary_not_comparable',
    to: 'undecidable',
    rule: 'A missing or changed primary metric definition cannot establish improvement.',
  },
  {
    from: 'initial',
    event: 'primary_not_improved',
    to: 'not_improved',
    rule: 'The primary objective must strictly improve.',
  },
  {
    from: 'initial',
    event: 'guard_regressed',
    to: 'not_improved',
    rule: 'No guard may regress, even when the primary objective improves.',
  },
  {
    from: 'initial',
    event: 'primary_strictly_improved',
    to: 'improved',
    rule: 'Strict primary improvement, valid evidence, and no guard regression are required.',
  },
  {
    from: 'improved',
    event: 'evaluate',
    to: 'improved',
    rule: 'A verdict is terminal for one evaluation; diagnostics cannot change it.',
  },
  {
    from: 'not_improved',
    event: 'evaluate',
    to: 'not_improved',
    rule: 'Auxiliary improvements cannot overturn a failed primary objective or guard.',
  },
  {
    from: 'undecidable',
    event: 'evaluate',
    to: 'undecidable',
    rule: 'Missing comparability cannot be repaired by auxiliary metrics.',
  },
  {
    from: 'refused',
    event: 'evaluate',
    to: 'refused',
    rule: 'Refused inputs are never promoted by later diagnostic evidence.',
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEvidenceLevel(value: unknown): value is EvidenceLevel {
  return typeof value === 'string' && (EVIDENCE_LEVELS as readonly string[]).includes(value);
}

function isMetricDirection(value: unknown): value is MetricDirection {
  return value === 'higher_is_better' || value === 'lower_is_better';
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CrossGenerationVerdictError(
      'INVALID_INDICATOR_VALUE',
      `${label} must be a finite number.`,
    );
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CrossGenerationVerdictError('INVALID_INPUT', `${label} must be a non-empty string.`);
  }
  return value;
}

function validateDefinition(definition: MetricDefinition, label: string): void {
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

function validateIndicator(indicator: IndicatorValue, label: string): void {
  if (!isRecord(indicator)) {
    throw new CrossGenerationVerdictError('INVALID_INPUT', `${label} must be an indicator.`);
  }
  validateDefinition(indicator.definition, `${label}.definition`);
  requireFiniteNumber(indicator.value, `${label}.value`);
}

function validateUniqueIndicators(
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

function validateIndicators(indicators: GenerationIndicators, label: string): void {
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

function validateEvidenceLevel(evidence: GenerationEvidence, label: string): void {
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

function validateInput(input: CrossGenerationVerdictInput): void {
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

function sameDefinition(left: MetricDefinition, right: MetricDefinition): boolean {
  return (
    left.id === right.id &&
    left.definitionVersion === right.definitionVersion &&
    left.direction === right.direction &&
    left.unit === right.unit
  );
}

function compareMetric(previous: IndicatorValue, next: IndicatorValue): MetricDelta {
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

function findById(indicators: readonly IndicatorValue[], id: string): IndicatorValue | undefined {
  return indicators.find((indicator) => indicator.definition.id === id);
}

function compareCollection(
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

function primaryDefinitionError(
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

function evidenceSummary(from: EvidenceLevel, to: EvidenceLevel): EvidenceTransitionSummary {
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

function result(
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

function mapEvidenceError(error: unknown): CrossGenerationVerdictError {
  if (error instanceof CrossGenerationContractError) {
    if (error.code === 'EVIDENCE_REGRESSION' || error.code === 'EVIDENCE_LEVEL_SKIPPED') {
      return new CrossGenerationVerdictError(error.code, error.message);
    }
    return new CrossGenerationVerdictError('INVALID_EVIDENCE_TRANSITION', error.message);
  }
  throw error;
}

/**
 * Evaluates one generation pair. This function never mutates inputs and never
 * consults diagnostics when choosing the verdict.
 */
export function evaluateCrossGenerationVerdict(
  input: CrossGenerationVerdictInput,
): CrossGenerationVerdictResult {
  validateInput(input);

  const previousIndicators = input.previous.indicators;
  const nextIndicators = input.next.indicators;
  const previousPrimary = previousIndicators.primary;
  const nextPrimary = nextIndicators.primary;
  const previousGuards = previousIndicators.guards ?? [];
  const nextGuards = nextIndicators.guards ?? [];
  const diagnostics = compareCollection(
    previousIndicators.diagnostics ?? [],
    nextIndicators.diagnostics ?? [],
  );

  const definitionError = primaryDefinitionError(
    previousPrimary.definition,
    nextPrimary.definition,
  );
  if (definitionError !== undefined) {
    return result(
      'undecidable',
      'The primary objective definition is not comparable across generations.',
      [],
      diagnostics,
      { errorCode: definitionError },
    );
  }

  const primary = compareMetric(previousPrimary, nextPrimary);
  const guards: MetricDelta[] = [];
  for (const previousGuard of previousGuards) {
    const nextGuard = findById(nextGuards, previousGuard.definition.id);
    if (nextGuard === undefined) {
      return result(
        'undecidable',
        `Guard ${previousGuard.definition.id} is missing from the next generation.`,
        guards,
        diagnostics,
        { errorCode: 'MISSING_GUARD_METRIC', primary },
      );
    }
    if (!sameDefinition(previousGuard.definition, nextGuard.definition)) {
      return result(
        'undecidable',
        `Guard ${previousGuard.definition.id} changed definition across generations.`,
        guards,
        diagnostics,
        { errorCode: 'GUARD_DEFINITION_CHANGED', primary },
      );
    }
    guards.push(compareMetric(previousGuard, nextGuard));
  }

  let evidenceTransition: EvidenceTransitionSummary;
  try {
    assertEvidenceTransition(input.previous.evidence.level, input.next.evidence.level);
    evidenceTransition = evidenceSummary(input.previous.evidence.level, input.next.evidence.level);
  } catch (error: unknown) {
    throw mapEvidenceError(error);
  }

  if (!primary.improved) {
    return result(
      'not_improved',
      'The primary objective did not strictly improve.',
      guards,
      diagnostics,
      { primary, evidenceTransition },
    );
  }
  const regressedGuard = guards.find((guard) => guard.regressed);
  if (regressedGuard !== undefined) {
    return result(
      'not_improved',
      `Guard ${regressedGuard.id} regressed; primary improvement is vetoed.`,
      guards,
      diagnostics,
      { primary, evidenceTransition },
    );
  }
  return result(
    'improved',
    'The primary objective strictly improved, evidence advanced legally, and no guard regressed.',
    guards,
    diagnostics,
    { primary, evidenceTransition },
  );
}

/**
 * Refusal adapter for orchestration boundaries that represent malformed input
 * as data. Multiple primaries and absent evidence are refused, never guessed.
 */
export function refuseCrossGenerationVerdict(
  code: Extract<
    CrossGenerationVerdictErrorCode,
    'MULTIPLE_PRIMARY_OBJECTIVES' | 'MISSING_PRIMARY_OBJECTIVE' | 'MISSING_EVIDENCE_LEVEL'
  >,
  reason: string,
): CrossGenerationVerdictResult {
  return result('refused', reason, [], [], { errorCode: code });
}

export function assertSinglePrimaryObjective(
  primaryObjectives: readonly IndicatorValue[],
): IndicatorValue {
  if (!Array.isArray(primaryObjectives) || primaryObjectives.length === 0) {
    throw new CrossGenerationVerdictError(
      'MISSING_PRIMARY_OBJECTIVE',
      'Exactly one primary objective is required.',
    );
  }
  if (primaryObjectives.length !== 1) {
    throw new CrossGenerationVerdictError(
      'MULTIPLE_PRIMARY_OBJECTIVES',
      'Multiple primary objectives are refused; auxiliary metrics cannot be promoted.',
    );
  }
  const primary = primaryObjectives[0];
  if (primary === undefined) {
    throw new CrossGenerationVerdictError(
      'MISSING_PRIMARY_OBJECTIVE',
      'Exactly one primary objective is required.',
    );
  }
  validateIndicator(primary, 'primaryObjectives[0]');
  return primary;
}
