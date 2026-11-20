/**
 * 跨代判决：公开 API（evaluate / refuse / assert）。
 *
 * 拆分说明（结构棘轮：单文件 ≤300 行）：
 * - 类型与常量 → ./cross-generation-verdict.types.js
 * - 状态转移表 → ./cross-generation-verdict.transitions.js
 * - 输入校验与比较 → ./cross-generation-verdict.internal.js
 * 下游 `from './cross-generation-verdict.js'` 无需改动（原样 re-export）。
 */

import { assertEvidenceTransition } from './cross-generation-contract.js';
import {
  compareCollection,
  compareMetric,
  evidenceSummary,
  findById,
  mapEvidenceError,
  primaryDefinitionError,
  result,
  sameDefinition,
  validateIndicator,
  validateInput,
} from './cross-generation-verdict.internal.js';
import { CrossGenerationVerdictError } from './cross-generation-verdict.types.js';
import type {
  CrossGenerationVerdictErrorCode,
  CrossGenerationVerdictInput,
  CrossGenerationVerdictResult,
  EvidenceTransitionSummary,
  IndicatorValue,
  MetricDelta,
} from './cross-generation-verdict.types.js';

export * from './cross-generation-verdict.types.js';
export * from './cross-generation-verdict.transitions.js';

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
