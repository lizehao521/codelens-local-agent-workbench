/**
 * P4′ 对抗与防假绿测试——skip/exclude/断言弱化三项防假绿检测
 *
 * 本文件强化「跨代判决层」的对抗维；检测 skip 的用例均以字符串字面量为输入，
 * 本文件自身无真实 skip/.only。从 cross-generation-adversarial.test.ts 拆出（结构棘轮 ≤300 行）。
 */

import { describe, expect, it } from 'vitest';
import {
  detectAssertionWeakening,
  detectExclusionAnomaly,
  detectSkippedTests,
} from './cross-generation-adversarial.js';

// ---------------------------------------------------------------------------
// 防假绿检测：skip/todo/.only
// ---------------------------------------------------------------------------

describe('detectSkippedTests', () => {
  it('detects it.skip', () => {
    const source = `it.skip('should work', () => { expect(1).toBe(1); });`;
    const result = detectSkippedTests(source);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.some((p) => p.kind === 'skip')).toBe(true);
    expect(result.riskLevel).toBe('high');
  });

  it('detects test.skip', () => {
    const source = `test.skip('should work', () => { expect(1).toBe(1); });`;
    const result = detectSkippedTests(source);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.some((p) => p.kind === 'skip')).toBe(true);
  });

  it('detects describe.skip', () => {
    const source = `describe.skip('suite', () => { it('works', () => {}); });`;
    const result = detectSkippedTests(source);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.some((p) => p.kind === 'skip')).toBe(true);
  });

  it('detects it.todo', () => {
    const source = `it.todo('should implement later');`;
    const result = detectSkippedTests(source);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.some((p) => p.kind === 'todo')).toBe(true);
  });

  it('detects test.todo', () => {
    const source = `test.todo('should implement later');`;
    const result = detectSkippedTests(source);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.some((p) => p.kind === 'todo')).toBe(true);
  });

  it('detects it.only as critical', () => {
    const source = `it.only('focused test', () => { expect(1).toBe(1); });`;
    const result = detectSkippedTests(source);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.some((p) => p.kind === 'only')).toBe(true);
    expect(result.riskLevel).toBe('critical');
  });

  it('detects describe.only as critical', () => {
    const source = `describe.only('focused suite', () => { it('works', () => {}); });`;
    const result = detectSkippedTests(source);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.some((p) => p.kind === 'only')).toBe(true);
    expect(result.riskLevel).toBe('critical');
  });

  it('detects xit', () => {
    const source = `xit('disabled test', () => { expect(1).toBe(1); });`;
    const result = detectSkippedTests(source);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.some((p) => p.kind === 'xit')).toBe(true);
  });

  it('detects xdescribe', () => {
    const source = `xdescribe('disabled suite', () => { it('works', () => {}); });`;
    const result = detectSkippedTests(source);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.some((p) => p.kind === 'xdescribe')).toBe(true);
  });

  it('detects xtest', () => {
    const source = `xtest('disabled test', () => { expect(1).toBe(1); });`;
    const result = detectSkippedTests(source);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.some((p) => p.kind === 'xtest')).toBe(true);
  });

  it('returns no risk for clean source', () => {
    const source = `
      describe('suite', () => {
        it('works', () => { expect(1).toBe(1); });
        test('also works', () => { expect(2).toBe(2); });
      });
    `;
    const result = detectSkippedTests(source);
    expect(result.hasRisk).toBe(false);
    expect(result.patterns).toEqual([]);
    expect(result.riskLevel).toBe('none');
  });

  it('detects multiple patterns in one source', () => {
    const source = `
      it.skip('skipped', () => {});
      it.only('focused', () => {});
      xit('disabled', () => {});
    `;
    const result = detectSkippedTests(source);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.length).toBe(3);
    expect(result.riskLevel).toBe('critical');
  });

  it('reports correct line numbers', () => {
    const source = `line1\nline2\nit.skip('test', () => {});\nline4`;
    const result = detectSkippedTests(source);
    expect(result.patterns[0]?.line).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 防假绿检测：测试集合异常缩减
// ---------------------------------------------------------------------------

describe('detectExclusionAnomaly', () => {
  it('detects significant reduction above threshold', () => {
    const result = detectExclusionAnomaly(100, 80, { threshold: 0.1 });
    expect(result.hasRisk).toBe(true);
    expect(result.reductionRatio).toBe(0.2);
    expect(result.reason).toContain('超过阈值');
  });

  it('passes when reduction is within threshold', () => {
    const result = detectExclusionAnomaly(100, 95, { threshold: 0.1 });
    expect(result.hasRisk).toBe(false);
    expect(result.reductionRatio).toBe(0.05);
  });

  it('detects exclusion patterns with reduction', () => {
    const result = detectExclusionAnomaly(100, 98, {
      threshold: 0.1,
      excludePatterns: ['**/*.slow.test.ts'],
    });
    expect(result.hasRisk).toBe(true);
    expect(result.reason).toContain('配置排除模式');
  });

  it('passes when no reduction', () => {
    const result = detectExclusionAnomaly(100, 100);
    expect(result.hasRisk).toBe(false);
    expect(result.reductionRatio).toBe(0);
  });

  it('passes when count increases', () => {
    const result = detectExclusionAnomaly(100, 110);
    expect(result.hasRisk).toBe(false);
    expect(result.reductionRatio).toBeLessThan(0);
  });

  it('uses default threshold of 0.1', () => {
    const result = detectExclusionAnomaly(100, 85);
    expect(result.threshold).toBe(0.1);
    expect(result.hasRisk).toBe(true);
  });

  it('handles zero baseline', () => {
    const result = detectExclusionAnomaly(0, 0);
    expect(result.hasRisk).toBe(false);
    expect(result.reductionRatio).toBe(0);
  });

  it('detects exact threshold boundary', () => {
    const result = detectExclusionAnomaly(100, 90, { threshold: 0.1 });
    expect(result.hasRisk).toBe(false);
    expect(result.reductionRatio).toBe(0.1);
  });

  it('detects just above threshold', () => {
    const result = detectExclusionAnomaly(100, 89, { threshold: 0.1 });
    expect(result.hasRisk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 防假绿检测：断言弱化
// ---------------------------------------------------------------------------

describe('detectAssertionWeakening', () => {
  it('detects toEqual to toContain weakening', () => {
    const diff = `
- expect(result).toEqual({ a: 1, b: 2 });
+ expect(result).toContain({ a: 1 });
    `;
    const result = detectAssertionWeakening(diff);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.some((p) => p.kind === 'toEqual_to_toContain')).toBe(true);
  });

  it('detects toBe to toEqual strict-to-loose weakening', () => {
    const diff = `
- expect(value).toBe(42);
+ expect(value).toEqual(42);
    `;
    const result = detectAssertionWeakening(diff);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.some((p) => p.kind === 'strict_to_loose')).toBe(true);
  });

  it('detects toBe to toBeTruthy weakening', () => {
    const diff = `
- expect(value).toBe(true);
+ expect(value).toBeTruthy();
    `;
    const result = detectAssertionWeakening(diff);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.some((p) => p.kind === 'toBe_to_toBeTruthy')).toBe(true);
  });

  it('detects toHaveLength to toBeGreaterThan weakening', () => {
    const diff = `
- expect(items).toHaveLength(5);
+ expect(items.length).toBeGreaterThan(0);
    `;
    const result = detectAssertionWeakening(diff);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.some((p) => p.kind === 'toHaveLength_to_toBeGreaterThan')).toBe(true);
  });

  it('detects assertion removal', () => {
    const diff = `
- expect(result).toBeDefined();
- expect(result.value).toBe(42);
+ // removed assertions
    `;
    const result = detectAssertionWeakening(diff);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.some((p) => p.kind === 'assertion_removed')).toBe(true);
    expect(result.riskLevel).toBe('critical');
  });

  it('returns no risk for unchanged assertions', () => {
    const diff = `
- expect(result).toBe(42);
+ expect(result).toBe(42);
    `;
    const result = detectAssertionWeakening(diff);
    expect(result.hasRisk).toBe(false);
  });

  it('returns no risk for strengthened assertions', () => {
    const diff = `
- expect(result).toContain({ a: 1 });
+ expect(result).toEqual({ a: 1, b: 2 });
    `;
    const result = detectAssertionWeakening(diff);
    expect(result.hasRisk).toBe(false);
  });

  it('handles non-diff source without weakening', () => {
    const source = `expect(result).toBe(42);`;
    const result = detectAssertionWeakening(source);
    expect(result.hasRisk).toBe(false);
  });

  it('detects multiple weakening patterns', () => {
    const diff = `
- expect(a).toBe(1);
+ expect(a).toBeTruthy();
- expect(b).toEqual({ x: 1 });
+ expect(b).toContain({ x: 1 });
    `;
    const result = detectAssertionWeakening(diff);
    expect(result.hasRisk).toBe(true);
    expect(result.patterns.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 综合防假绿评估
// ---------------------------------------------------------------------------
