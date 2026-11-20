/**
 * cross-generation-verdict：状态机与判决决策测试。
 * 从 cross-generation-verdict.test.ts 拆出（结构棘轮 ≤300 行）。
 */
import { describe, expect, it } from 'vitest';
import {
  CROSS_GENERATION_VERDICT_RULES_VERSION,
  CrossGenerationVerdictError,
  VERDICT_STATE_TRANSITIONS,
  assertSinglePrimaryObjective,
  evaluateCrossGenerationVerdict,
  refuseCrossGenerationVerdict,
} from './cross-generation-verdict.js';
import type { CrossGenerationVerdictInput } from './cross-generation-verdict.js';
import type { EvidenceLevel, MetricDefinition } from './cross-generation-contract.js';
import {
  diagnosticDefinition,
  evidence,
  guardDefinition,
  indicator,
  indicators,
  input,
  primaryDefinition,
} from './cross-generation-verdict.fixture.js';

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

