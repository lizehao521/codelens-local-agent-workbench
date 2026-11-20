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

// ── B 项：一致性阴影视图（codelens exp167 裁定）──────────────────────────────
import { buildConsistencyShadow, type ConsistencyShadowRow } from './cross-generation-consistency.js';

function rows(...ledgerPaths: (string | null)[]): ConsistencyShadowRow[] {
  return ledgerPaths.map((lp, i) => ({ generation: i + 1, ledgerPath: lp }));
}

describe('buildConsistencyShadow（B 项阴影旁路）', () => {
  it('安全护栏：视图无 consistent 布尔、status 恒 partial、两条不可用判据固定列出', () => {
    const v = buildConsistencyShadow(rows('a', 'b'), 'improved');
    expect(v.status).toBe('partial');
    expect(v).not.toHaveProperty('consistent');
    expect(v.unavailableChecks).toEqual([
      { inv: 'INV-1', cause: 'no_diff_text' },
      { inv: 'INV-2', cause: 'evidence_level_unmapped' },
    ]);
  });

  it('improved + 相邻两代 ledger_path 相同（零证据停滞）→ INV-3 warning + gens', () => {
    const v = buildConsistencyShadow(rows('x', 'same', 'same'), 'improved');
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]).toMatchObject({ inv: 'INV-3', sev: 'warning' });
    expect(v.violations[0]?.gens).toEqual([2, 3]);
  });

  it('improved + 相邻两代 ledger_path 不同 → 无 violation（INV-3 不误报）', () => {
    const v = buildConsistencyShadow(rows('a', 'b', 'c'), 'improved');
    expect(v.violations).toHaveLength(0);
  });

  it('not_improved + 零证据停滞 → 无 INV-3（improved 才触发）', () => {
    const v = buildConsistencyShadow(rows('same', 'same'), 'not_improved');
    expect(v.violations).toHaveLength(0);
  });

  it('refused → 空 violations（INV-4 前半短接），不可用清单仍在', () => {
    const v = buildConsistencyShadow(rows('same', 'same'), 'refused');
    expect(v.violations).toHaveLength(0);
    expect(v.unavailableChecks).toHaveLength(2);
  });

  it('空数组 / 单行不抛错，无 violation', () => {
    expect(buildConsistencyShadow([], 'improved').violations).toHaveLength(0);
    expect(buildConsistencyShadow(rows('only'), 'improved').violations).toHaveLength(0);
  });

  it('乱序行按 generation 升序重排后再判停滞', () => {
    const shuffled: ConsistencyShadowRow[] = [
      { generation: 3, ledgerPath: 'same' },
      { generation: 1, ledgerPath: 'a' },
      { generation: 2, ledgerPath: 'same' },
    ];
    const v = buildConsistencyShadow(shuffled, 'improved');
    expect(v.violations[0]?.gens).toEqual([2, 3]);
  });
});
