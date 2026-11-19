// src/services/rsi/cross-generation-verdict.test.ts
import { describe, expect, it } from 'vitest';
import {
  CROSS_GENERATION_VERDICT_RULES_VERSION,
  CrossGenerationVerdictError,
  VERDICT_STATE_TRANSITIONS,
  assertSinglePrimaryObjective,
  evaluateCrossGenerationVerdict,
  refuseCrossGenerationVerdict,
} from './cross-generation-verdict.js';
import type {
  CrossGenerationVerdictInput,
  GenerationIndicators,
  IndicatorValue,
} from './cross-generation-verdict.js';
import type {
  EvidenceLevel,
  GenerationEvidence,
  MetricDefinition,
} from './cross-generation-contract.js';

const primaryDefinition: MetricDefinition = {
  id: 'test_pass_rate',
  definitionVersion: 'pass-rate.v1',
  direction: 'higher_is_better',
  unit: 'ratio',
};

const guardDefinition: MetricDefinition = {
  id: 'suite_floor_ratio',
  definitionVersion: 'suite-floor.v1',
  direction: 'higher_is_better',
  unit: 'ratio',
};

const diagnosticDefinition: MetricDefinition = {
  id: 'tool_success_rate',
  definitionVersion: 'tool-success.v1',
  direction: 'higher_is_better',
  unit: 'ratio',
};

function indicator(
  definition: MetricDefinition,
  value: number,
): IndicatorValue {
  return { definition, value };
}

function indicators(
  primary: number,
  guard = 1,
  diagnostic = 0.5,
): GenerationIndicators {
  return {
    primary: indicator(primaryDefinition, primary),
    guards: [indicator(guardDefinition, guard)],
    diagnostics: [indicator(diagnosticDefinition, diagnostic)],
  };
}

function evidence(level: EvidenceLevel): GenerationEvidence {
  switch (level) {
    case 'designed':
      return { level };
    case 'landed':
      return { level, landedFilesHash: 'fixture-landed-files-hash' };
    case 'targeted_passed':
      return {
        level,
        landedFilesHash: 'fixture-landed-files-hash',
        targetedTestCommand: 'fixture-targeted-test-command',
      };
    case 'full_suite_passed':
      return {
        level,
        landedFilesHash: 'fixture-landed-files-hash',
        targetedTestCommand: 'fixture-targeted-test-command',
        fullSuiteCommand: 'fixture-full-suite-command',
      };
    case 'runtime_verified':
      return {
        level,
        landedFilesHash: 'fixture-landed-files-hash',
        targetedTestCommand: 'fixture-targeted-test-command',
        fullSuiteCommand: 'fixture-full-suite-command',
        runtimeEvidenceHash: 'fixture-runtime-evidence-hash',
      };
  }
}

function input(options: {
  readonly previousPrimary?: number;
  readonly nextPrimary?: number;
  readonly previousGuard?: number;
  readonly nextGuard?: number;
  readonly previousDiagnostic?: number;
  readonly nextDiagnostic?: number;
  readonly previousLevel?: EvidenceLevel;
  readonly nextLevel?: EvidenceLevel;
  readonly previousIndicators?: GenerationIndicators;
  readonly nextIndicators?: GenerationIndicators;
} = {}): CrossGenerationVerdictInput {
  return {
    rulesVersion: CROSS_GENERATION_VERDICT_RULES_VERSION,
    previous: {
      indicators:
        options.previousIndicators ??
        indicators(
          options.previousPrimary ?? 0.9,
          options.previousGuard ?? 1,
          options.previousDiagnostic ?? 0.5,
        ),
      evidence: evidence(options.previousLevel ?? 'landed'),
    },
    next: {
      indicators:
        options.nextIndicators ??
        indicators(
          options.nextPrimary ?? 0.91,
          options.nextGuard ?? 1,
          options.nextDiagnostic ?? 0.5,
        ),
      evidence: evidence(options.nextLevel ?? 'targeted_passed'),
    },
  };
}

describe('cross-generation verdict state machine', () => {
  it('declares all four terminal verdict states and fail-closed transitions', () => {
    expect(VERDICT_STATE_TRANSITIONS.map((transition) => transition.to)).toEqual(
      expect.arrayContaining(['improved', 'not_improved', 'undecidable', 'refused']),
    );
    expect(
      VERDICT_STATE_TRANSITIONS.some(
        (transition) =>
          transition.event === 'multiple_primary_objectives' && transition.to === 'refused',
      ),
    ).toBe(true);
    expect(
      VERDICT_STATE_TRANSITIONS.some(
        (transition) =>
          transition.event === 'invalid_evidence_transition' && transition.to === 'refused',
      ),
    ).toBe(true);
  });

  it('accepts exactly one primary objective and refuses zero or multiple primaries', () => {
    const primary = indicator(primaryDefinition, 0.9);
    expect(assertSinglePrimaryObjective([primary])).toBe(primary);
    expect(() => assertSinglePrimaryObjective([])).toThrowError(
      expect.objectContaining({ code: 'MISSING_PRIMARY_OBJECTIVE' }),
    );
    expect(() => assertSinglePrimaryObjective([primary, primary])).toThrowError(
      expect.objectContaining({ code: 'MULTIPLE_PRIMARY_OBJECTIVES' }),
    );
    expect(
      refuseCrossGenerationVerdict('MULTIPLE_PRIMARY_OBJECTIVES', 'Two primaries supplied.'),
    ).toMatchObject({
      verdict: 'refused',
      errorCode: 'MULTIPLE_PRIMARY_OBJECTIVES',
    });
  });

  it('refuses a missing evidence level instead of inferring one', () => {
    const malformed = input() as unknown as {
      previous: { evidence: { level?: EvidenceLevel } };
    };
    delete malformed.previous.evidence.level;
    expect(() => evaluateCrossGenerationVerdict(malformed as CrossGenerationVerdictInput)).toThrowError(
      expect.objectContaining({ code: 'MISSING_EVIDENCE_LEVEL' }),
    );
    expect(
      refuseCrossGenerationVerdict('MISSING_EVIDENCE_LEVEL', 'Historical evidence is absent.'),
    ).toMatchObject({ verdict: 'refused', errorCode: 'MISSING_EVIDENCE_LEVEL' });
  });
});

describe('cross-generation verdict decision logic', () => {
  it('returns improved only for strict primary improvement with legal evidence and stable guards', () => {
    const verdict = evaluateCrossGenerationVerdict(input());
    expect(verdict.verdict).toBe('improved');
    expect(verdict.primary).toMatchObject({ improved: true, regressed: false });
    expect(verdict.primary!.delta).toBeCloseTo(0.01, 10);
    expect(verdict.evidenceTransition).toMatchObject({
      from: 'landed',
      to: 'targeted_passed',
      ok: true,
    });
  });

  it('does not allow auxiliary improvement to offset a flat primary objective', () => {
    const verdict = evaluateCrossGenerationVerdict(
      input({ nextPrimary: 0.9, nextDiagnostic: 1 }),
    );
    expect(verdict.verdict).toBe('not_improved');
    expect(verdict.primary?.improved).toBe(false);
    expect(verdict.diagnostics[0]).toMatchObject({ improved: true, delta: 0.5 });
  });

  it('does not allow auxiliary improvement to offset primary regression', () => {
    const verdict = evaluateCrossGenerationVerdict(
      input({ nextPrimary: 0.8, nextDiagnostic: 1 }),
    );
    expect(verdict.verdict).toBe('not_improved');
    expect(verdict.primary?.regressed).toBe(true);
  });

  it('vetoes improved when any guard regresses despite primary improvement', () => {
    const verdict = evaluateCrossGenerationVerdict(
      input({ nextPrimary: 0.99, previousGuard: 1, nextGuard: 0.99 }),
    );
    expect(verdict.verdict).toBe('not_improved');
    expect(verdict.primary?.improved).toBe(true);
    expect(verdict.guards[0]?.regressed).toBe(true);
    expect(verdict.reason).toContain('vetoed');
  });

  it('supports lower-is-better primary and guard directions', () => {
    const duration: MetricDefinition = {
      id: 'duration',
      definitionVersion: 'duration.v1',
      direction: 'lower_is_better',
      unit: 'ms',
    };
    const memory: MetricDefinition = {
      id: 'memory',
      definitionVersion: 'memory.v1',
      direction: 'lower_is_better',
      unit: 'MiB',
    };
    const verdict = evaluateCrossGenerationVerdict(
      input({
        previousIndicators: {
          primary: indicator(duration, 100),
          guards: [indicator(memory, 50)],
        },
        nextIndicators: {
          primary: indicator(duration, 90),
          guards: [indicator(memory, 50)],
        },
      }),
    );
    expect(verdict.verdict).toBe('improved');
    expect(verdict.primary).toMatchObject({ delta: -10, improved: true });
  });

  it('returns undecidable when the primary definition version changes', () => {
    const changedDefinition: MetricDefinition = {
      ...primaryDefinition,
      definitionVersion: 'pass-rate.v2',
    };
    const verdict = evaluateCrossGenerationVerdict(
      input({
        nextIndicators: {
          primary: indicator(changedDefinition, 1),
          guards: [indicator(guardDefinition, 1)],
        },
      }),
    );
    expect(verdict.verdict).toBe('undecidable');
    expect(verdict.errorCode).toBe('PRIMARY_DEFINITION_CHANGED');
  });

  it('returns undecidable when a guard is absent or changes definition', () => {
    const missingGuard = evaluateCrossGenerationVerdict(
      input({
        nextIndicators: {
          primary: indicator(primaryDefinition, 0.99),
          guards: [],
        },
      }),
    );
    expect(missingGuard).toMatchObject({
      verdict: 'undecidable',
      errorCode: 'MISSING_GUARD_METRIC',
    });

    const changedGuard = evaluateCrossGenerationVerdict(
      input({
        nextIndicators: {
          primary: indicator(primaryDefinition, 0.99),
          guards: [
            indicator({ ...guardDefinition, definitionVersion: 'suite-floor.v2' }, 1),
          ],
        },
      }),
    );
    expect(changedGuard).toMatchObject({
      verdict: 'undecidable',
      errorCode: 'GUARD_DEFINITION_CHANGED',
    });
  });
});

describe('cross-generation evidence anti-regression', () => {
  it('rejects evidence regression from full_suite_passed to designed', () => {
    expect(() =>
      evaluateCrossGenerationVerdict(
        input({ previousLevel: 'full_suite_passed', nextLevel: 'designed' }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'EVIDENCE_REGRESSION' }));
  });

  it('rejects skipped evidence levels even when the primary improves', () => {
    expect(() =>
      evaluateCrossGenerationVerdict(
        input({ previousLevel: 'designed', nextLevel: 'targeted_passed' }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'EVIDENCE_LEVEL_SKIPPED' }));
  });

  it('uses the shared evidence transition contract for adjacent upgrades', () => {
    const verdict = evaluateCrossGenerationVerdict(
      input({ previousLevel: 'targeted_passed', nextLevel: 'full_suite_passed' }),
    );
    expect(verdict.verdict).toBe('improved');
    expect(verdict.evidenceTransition).toMatchObject({ fromIndex: 2, toIndex: 3, ok: true });
  });

  it('rejects non-finite metrics and duplicate guards fail-closed', () => {
    expect(() =>
      evaluateCrossGenerationVerdict(
        input({ previousIndicators: indicators(Number.NaN) }),
      ),
    ).toThrowError(CrossGenerationVerdictError);
    expect(() =>
      evaluateCrossGenerationVerdict(
        input({
          previousIndicators: {
            primary: indicator(primaryDefinition, 0.9),
            guards: [indicator(guardDefinition, 1), indicator(guardDefinition, 1)],
          },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'DUPLICATE_GUARD' }));
  });
});
