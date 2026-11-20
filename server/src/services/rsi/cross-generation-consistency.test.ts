/**
 * cross-generation-consistency 单元测试（旁路纯函数，不接 bridge、不阻断）。
 * 覆盖 INV-1/2/3 + INV-4前半的触发与不触发、warning 不影响 consistent、空 violations。
 * 字段全部按真实 interface 构造，不臆造。
 */
import { describe, it, expect } from 'vitest';
import type { CrossGenerationVerdictResult } from './cross-generation-verdict.js';
import type { StallVerdict, DiffInput } from './cross-generation-stall.js';
import type { OscillationAnalysis, RollbackDecision } from './cross-generation-oscillation.js';
import { evaluateConsistency, type ConsistencyInput } from './cross-generation-consistency.js';

function verdictOf(verdict: CrossGenerationVerdictResult['verdict']): CrossGenerationVerdictResult {
  return {
    verdict,
    rulesVersion: 'cross-generation-verdict.v1',
    reason: 'fixture',
    guards: [],
    diagnostics: [],
  };
}
function stallOf(reason: StallVerdict['reason'], stopped: boolean): StallVerdict {
  return { stopped, reason, detail: 'fixture', evidenceChain: [], crossGenerationVerdict: 'not_improved' };
}
function oscOf(verdict: OscillationAnalysis['verdict']): OscillationAnalysis {
  return { verdict, crossings: 0, netImprovement: 0, samples: 2 };
}
function rollbackOf(action: RollbackDecision['action']): RollbackDecision {
  return { action };
}
const REAL_DIFF: DiffInput = { diffText: '+ const improved = true;\n- const old = false;' };
const ZERO_DIFF: DiffInput = { diffText: '   \n// 仅注释变更\n/* block */' };
function input(o: {
  verdict: CrossGenerationVerdictResult['verdict'];
  diff?: DiffInput;
  stallReason?: StallVerdict['reason'];
  stopped?: boolean;
  rollback?: RollbackDecision['action'];
  oscillation?: OscillationAnalysis['verdict'];
}): ConsistencyInput {
  return {
    verdict: verdictOf(o.verdict),
    stall: stallOf(o.stallReason ?? 'none', o.stopped ?? false),
    oscillation: oscOf(o.oscillation ?? 'not_oscillating'),
    rollback: rollbackOf(o.rollback ?? 'no_rollback'),
    latestDiff: o.diff ?? REAL_DIFF,
  };
}

describe('evaluateConsistency', () => {
  it('一致场景：improved + 有效 diff + 无停滞 → consistent=true，无 violation', () => {
    const r = evaluateConsistency(input({ verdict: 'improved' }));
    expect(r.consistent).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('INV-1 触发：improved + 零有效 diff → contradiction，consistent=false', () => {
    const r = evaluateConsistency(input({ verdict: 'improved', diff: ZERO_DIFF }));
    expect(r.consistent).toBe(false);
    expect(r.violations.some((v) => v.invariant === 'INV-1' && v.severity === 'contradiction')).toBe(true);
  });

  it('INV-1 不触发：not_improved + 零 diff 不算矛盾（判决未宣称改进）', () => {
    const r = evaluateConsistency(input({ verdict: 'not_improved', diff: ZERO_DIFF }));
    expect(r.violations.some((v) => v.invariant === 'INV-1')).toBe(false);
  });

  it('INV-2 触发：not_improved + rollback + stall 无停滞 → contradiction', () => {
    const r = evaluateConsistency(input({ verdict: 'not_improved', rollback: 'rollback', stallReason: 'none', stopped: false }));
    expect(r.consistent).toBe(false);
    expect(r.violations.some((v) => v.invariant === 'INV-2' && v.severity === 'contradiction')).toBe(true);
  });

  it('INV-2 不触发：not_improved + rollback 但 stall 有停滞佐证 → 无矛盾', () => {
    const r = evaluateConsistency(input({ verdict: 'not_improved', rollback: 'rollback', stallReason: 'zero_diff', stopped: true }));
    expect(r.violations.some((v) => v.invariant === 'INV-2')).toBe(false);
  });

  it('INV-2 不触发：rollback=undecidable 不视为回退决策', () => {
    const r = evaluateConsistency(input({ verdict: 'not_improved', rollback: 'undecidable' }));
    expect(r.violations.some((v) => v.invariant === 'INV-2')).toBe(false);
  });

  it('INV-3 触发：improved + stall 停滞 → warning，但 consistent 仍为 true', () => {
    const r = evaluateConsistency(input({ verdict: 'improved', stallReason: 'signature_repeated', stopped: true }));
    expect(r.consistent).toBe(true);
    expect(r.violations.some((v) => v.invariant === 'INV-3' && v.severity === 'warning')).toBe(true);
  });

  it('INV-4 前半：refused 跳过 INV-1/INV-3，即便零 diff + 停滞仍一致', () => {
    const r = evaluateConsistency(input({
      verdict: 'refused', diff: ZERO_DIFF, stallReason: 'zero_diff', stopped: true, rollback: 'rollback',
    }));
    expect(r.consistent).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('undecidable 不触发任何证据类不变量', () => {
    const r = evaluateConsistency(input({ verdict: 'undecidable', diff: ZERO_DIFF, rollback: 'rollback' }));
    expect(r.consistent).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('多违规并存：improved + 零 diff + 停滞 → INV-1(contradiction) 与 INV-3(warning) 同时在列', () => {
    const r = evaluateConsistency(input({
      verdict: 'improved', diff: ZERO_DIFF, stallReason: 'zero_diff', stopped: true,
    }));
    expect(r.consistent).toBe(false);
    expect(r.violations.map((v) => v.invariant).sort()).toEqual(['INV-1', 'INV-3']);
  });
});
