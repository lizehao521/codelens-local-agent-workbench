// 自适应输出预算：推理型模型把 max_tokens 花光时的唯一一次抬预算规则。
// 判据（反向）：不能无限翻倍、不能低于 2048、非法输入不能返回 0/NaN。
import { describe, expect, it } from 'vitest';
import {
  adaptOutputBudget,
  OUTPUT_BUDGET_CAP,
  OUTPUT_BUDGET_MIN,
} from '../src/services/agent/output-budget.js';

describe('adaptOutputBudget', () => {
  it('小预算抬到下限 2048', () => {
    expect(adaptOutputBudget(512)).toBe(OUTPUT_BUDGET_MIN);
    expect(adaptOutputBudget(1)).toBe(OUTPUT_BUDGET_MIN);
  });

  it('中等预算翻倍', () => {
    expect(adaptOutputBudget(1500)).toBe(3000);
    expect(adaptOutputBudget(2048)).toBe(4096);
  });

  it('超过硬上限时收敛到 4096', () => {
    expect(adaptOutputBudget(4000)).toBe(OUTPUT_BUDGET_CAP);
    expect(adaptOutputBudget(1_000_000)).toBe(OUTPUT_BUDGET_CAP);
  });

  it('非法输入走兜底而不是返回 0/NaN', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const next = adaptOutputBudget(bad);
      expect(Number.isFinite(next)).toBe(true);
      expect(next).toBe(OUTPUT_BUDGET_MIN);
    }
  });

  it('判别力：结果永远落在 [2048, 4096]', () => {
    for (const n of [0, 1, 500, 1024, 2048, 3000, 4096, 99999]) {
      const next = adaptOutputBudget(n);
      expect(next).toBeGreaterThanOrEqual(OUTPUT_BUDGET_MIN);
      expect(next).toBeLessThanOrEqual(OUTPUT_BUDGET_CAP);
    }
  });
});
