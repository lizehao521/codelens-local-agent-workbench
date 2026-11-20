/**
 * cross-generation-verdict：证据等级抗回退测试。
 * 从 cross-generation-verdict.test.ts 拆出（结构棘轮 ≤300 行）。
 */
import { describe, expect, it } from 'vitest';
import {
  CrossGenerationVerdictError,
  evaluateCrossGenerationVerdict,
} from './cross-generation-verdict.js';
import {
  guardDefinition,
  indicator,
  indicators,
  input,
  primaryDefinition,
} from './cross-generation-verdict.fixture.js';

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

