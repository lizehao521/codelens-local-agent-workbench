/** P5′ cross-generation adapter tests: exhaustive verdict mapping, stable serialization, and legacy consumption. */
import { describe, expect, it } from 'vitest';
import {
  adaptCrossGenerationVerdict,
  adaptLegacyBridgeResult,
  serializeCrossGenerationVerdict,
  toRsiVerdict,
} from './cross-generation-adapter.js';
import type {
  CrossGenerationVerdict,
  CrossGenerationVerdictResult,
} from './cross-generation-verdict.js';
import type { RsiBridgeResult } from './rsi-bridge.service.js';

function makeResult(verdict: CrossGenerationVerdict): CrossGenerationVerdictResult {
  return {
    verdict,
    rulesVersion: 'cross-generation-verdict.v1',
    reason: `reason:${verdict}`,
    guards: [],
    diagnostics: [],
  };
}

describe('cross-generation adapter', () => {
  it('maps every cross-generation verdict exhaustively without inventing states', () => {
    const cases: readonly [CrossGenerationVerdict, string][] = [
      ['improved', 'improved'],
      ['not_improved', 'not_improved'],
      ['undecidable', 'undecidable'],
      ['refused', 'refused'],
    ];

    for (const [verdict, expected] of cases) {
      expect(toRsiVerdict(makeResult(verdict))).toBe(expected);
    }
  });

  it('keeps the verdict mapping unchanged when errorCode is present', () => {
    const result: CrossGenerationVerdictResult = {
      ...makeResult('refused'),
      errorCode: 'EVIDENCE_REGRESSION',
    };

    expect(toRsiVerdict(result)).toBe('refused');
    expect(serializeCrossGenerationVerdict(result).errorCode).toBe('EVIDENCE_REGRESSION');
  });

  it('serializes with stable JSON round-trip and no undefined leakage', () => {
    const result: CrossGenerationVerdictResult = {
      verdict: 'improved',
      rulesVersion: 'cross-generation-verdict.v1',
      reason: 'primary improved and guards held',
      primary: {
        id: 'test_pass_rate',
        direction: 'higher_is_better',
        previous: 0.9,
        next: 1,
        delta: 0.1,
        improved: true,
        regressed: false,
      },
      guards: [
        {
          id: 'suite_floor_ratio',
          direction: 'higher_is_better',
          previous: 1,
          next: 1,
          delta: 0,
          improved: false,
          regressed: false,
        },
      ],
      diagnostics: [],
    };

    const serialized = serializeCrossGenerationVerdict(result);
    const json = JSON.stringify(serialized);
    const roundTripped: unknown = JSON.parse(json);

    expect(roundTripped).toEqual(serialized);
    expect(JSON.stringify(roundTripped)).toBe(json);
    expect(json).not.toContain('undefined');
    expect(Object.keys(serialized)).toEqual([
      'verdict',
      'rulesVersion',
      'reason',
      'guards',
      'diagnostics',
      'primary',
    ]);
  });

  it('omits optional fields when absent and preserves them when present', () => {
    const withoutOptional = serializeCrossGenerationVerdict(makeResult('undecidable'));
    expect('errorCode' in withoutOptional).toBe(false);
    expect('primary' in withoutOptional).toBe(false);
    expect('evidenceTransition' in withoutOptional).toBe(false);

    const withOptional = serializeCrossGenerationVerdict({
      ...makeResult('not_improved'),
      errorCode: 'MISSING_EVIDENCE_LEVEL',
      primary: {
        id: 'test_pass_rate',
        direction: 'higher_is_better',
        previous: 1,
        next: 0.99,
        delta: -0.01,
        improved: false,
        regressed: true,
      },
      evidenceTransition: {
        from: 'landed',
        to: 'targeted_passed',
        fromIndex: 1,
        toIndex: 2,
        ok: true,
      },
    });
    expect(withOptional.errorCode).toBe('MISSING_EVIDENCE_LEVEL');
    expect(withOptional.primary).toEqual({
      delta: -0.01,
      direction: 'higher_is_better',
      id: 'test_pass_rate',
      improved: false,
      next: 0.99,
      previous: 1,
      regressed: true,
    });
    expect(withOptional.evidenceTransition).toEqual({
      from: 'landed',
      fromIndex: 1,
      ok: true,
      to: 'targeted_passed',
      toIndex: 2,
    });
  });

  it('adapts legacy bridge results into the same consumption shape', () => {
    const legacy: RsiBridgeResult = {
      state: 'not_improved',
      exitCode: 1,
      reasons: ['target metric regressed'],
      metrics: [{ metric: 'test_pass_rate', before: 1, after: 0.99, better: false }],
      reportRaw: '{"state":"not_improved"}',
      ledgerPath: '/tmp/ledger.json',
    };

    const adapted = adaptLegacyBridgeResult(legacy);
    expect(adapted).toEqual({
      state: 'not_improved',
      verdict: 'not_improved',
      source: 'legacy_bridge',
      reason: 'target metric regressed',
      reasons: ['target metric regressed'],
      exitCode: 1,
      metrics: [{ metric: 'test_pass_rate', before: 1, after: 0.99, better: false }],
      reportRaw: '{"state":"not_improved"}',
      ledgerPath: '/tmp/ledger.json',
    });
    expect(adapted.metrics).not.toBe(legacy.metrics);
    expect(adapted.reasons).not.toBe(legacy.reasons);
  });

  it('places new verdicts and legacy results in one consumption口径', () => {
    const crossGeneration = adaptCrossGenerationVerdict(makeResult('improved'));
    const legacy = adaptLegacyBridgeResult({
      state: 'improved',
      exitCode: 0,
      reasons: ['legacy improved'],
      reportRaw: 'legacy-report',
      ledgerPath: 'legacy-ledger',
    });

    expect(crossGeneration.state).toBe(legacy.state);
    expect(crossGeneration.verdict).toBe(legacy.verdict);
    expect(crossGeneration.source).toBe('cross_generation');
    expect(legacy.source).toBe('legacy_bridge');
    expect(JSON.parse(crossGeneration.reportRaw)).toEqual(crossGeneration.serializedVerdict);
  });

  it('rejects non-JSON values instead of producing false-green serialization', () => {
    const invalid: CrossGenerationVerdictResult = {
      ...makeResult('improved'),
      primary: {
        id: 'test_pass_rate',
        direction: 'higher_is_better',
        previous: Number.NaN,
        next: 1,
        delta: Number.NaN,
        improved: true,
        regressed: false,
      },
    };

    expect(() => serializeCrossGenerationVerdict(invalid)).toThrow(TypeError);
  });
});
