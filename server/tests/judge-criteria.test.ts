/**
 * L0 机械判据单元测试。
 *
 * 重点不是「跑通」，而是钉死每条判据的三态语义：
 *  - pass / fail 的边界在哪；
 *  - 什么时候必须是 unexec（没证据就不许下结论，C4）；
 *  - 阈值的安全区间不可被自我修改放宽（防止「改口径迁就结果」）。
 */

import { describe, it, expect } from 'vitest';
import {
  toolSuccessRate,
  taskTerminal,
  loopHealth,
  approvalFriction,
  budgetEfficiency,
  resolveThresholds,
  DEFAULT_L0_THRESHOLDS,
  L0_CRITERIA,
  type L0Thresholds,
} from '../src/services/judge/criteria.js';
import type { JudgeEvidence } from '../src/services/judge/types.js';

const T: L0Thresholds = DEFAULT_L0_THRESHOLDS;

function evidence(over: Partial<JudgeEvidence> = {}): JudgeEvidence {
  return {
    sessionId: 's1',
    finishReason: 'stop',
    iteration: 3,
    tokenBudget: 100_000,
    usage: { promptTokens: 10_000, completionTokens: 5_000 },
    toolCalls: [{ status: 'success', display_name: '读取文件' }],
    approvals: [{ status: 'decided', decision: 'allow_once' }],
    circuitOpened: false,
    ...over,
  };
}

describe('L0 · tool.success_rate', () => {
  it('成功率达标 → pass，并把比例写进 detail', () => {
    const v = toolSuccessRate(
      evidence({
        toolCalls: [
          { status: 'success', display_name: 'a' },
          { status: 'success', display_name: 'b' },
          { status: 'failed', display_name: 'c' },
        ],
      }),
      T,
    );
    expect(v.status).toBe('pass');
    expect(v.score).toBeCloseTo(0.667, 2);
  });

  it('成功率低于下限 → fail', () => {
    const v = toolSuccessRate(
      evidence({
        toolCalls: [
          { status: 'failed', display_name: 'a' },
          { status: 'failed', display_name: 'b' },
          { status: 'success', display_name: 'c' },
        ],
      }),
      T,
    );
    expect(v.status).toBe('fail');
  });

  it('无终态调用 → unexec（不把「还没发生」当成失败）', () => {
    const v = toolSuccessRate(
      evidence({
        toolCalls: [
          { status: 'pending', display_name: 'a' },
          { status: 'running', display_name: 'b' },
        ],
      }),
      T,
    );
    expect(v.status).toBe('unexec');
  });

  it('pending/running 不进分母：1 成功 + 1 运行中 = 100%', () => {
    const v = toolSuccessRate(
      evidence({
        toolCalls: [
          { status: 'success', display_name: 'a' },
          { status: 'running', display_name: 'b' },
        ],
      }),
      T,
    );
    expect(v.score).toBe(1);
  });

  it('rejected 计入分母（用户拒绝也是没做成事）', () => {
    const v = toolSuccessRate(
      evidence({
        toolCalls: [
          { status: 'success', display_name: 'a' },
          { status: 'rejected', display_name: 'b' },
        ],
      }),
      T,
    );
    expect(v.score).toBe(0.5);
  });
});

describe('L0 · task.terminal', () => {
  it.each([
    ['stop', 'pass'],
    ['max_iterations', 'fail'],
    ['budget_exhausted', 'fail'],
    ['aborted', 'fail'],
    ['circuit_open', 'fail'],
  ])('终止原因 %s → %s', (reason, expected) => {
    const v = taskTerminal(evidence({ finishReason: reason }), T);
    expect(v.status).toBe(expected);
  });

  it('未知终止原因 → unexec，而不是猜成 pass', () => {
    const v = taskTerminal(evidence({ finishReason: 'something_new' }), T);
    expect(v.status).toBe('unexec');
    expect(v.detail).toContain('something_new');
  });
});

describe('L0 · loop.health', () => {
  it('未熔断 → pass', () => {
    expect(loopHealth(evidence(), T).status).toBe('pass');
  });
  it('触发过熔断 → fail', () => {
    expect(loopHealth(evidence({ circuitOpened: true }), T).status).toBe('fail');
  });
});

describe('L0 · approval.friction', () => {
  it('无审批发生 → unexec（没摩擦 ≠ 没风险，只是没测到）', () => {
    const v = approvalFriction(evidence({ approvals: [] }), T);
    expect(v.status).toBe('unexec');
  });

  it('拒绝率超上限 → fail', () => {
    const v = approvalFriction(
      evidence({
        approvals: [
          { status: 'decided', decision: 'reject' },
          { status: 'decided', decision: 'reject' },
          { status: 'decided', decision: 'allow_once' },
        ],
      }),
      T,
    );
    expect(v.status).toBe('fail');
    expect(v.score).toBeCloseTo(0.667, 2);
  });

  it('拒绝率在上限内 → pass', () => {
    const v = approvalFriction(
      evidence({
        approvals: [
          { status: 'decided', decision: 'reject' },
          { status: 'decided', decision: 'allow_once' },
          { status: 'decided', decision: 'allow_once' },
        ],
      }),
      T,
    );
    expect(v.status).toBe('pass');
  });

  it('仅 pending 的审批不算已决策（不虚增分母）', () => {
    const v = approvalFriction(evidence({ approvals: [{ status: 'pending', decision: null }] }), T);
    expect(v.status).toBe('unexec');
  });
});

describe('L0 · budget.efficiency', () => {
  it('无预算 → unexec', () => {
    expect(budgetEfficiency(evidence({ tokenBudget: 0 }), T).status).toBe('unexec');
  });
  it('超支 → fail', () => {
    const v = budgetEfficiency(
      evidence({ tokenBudget: 1000, usage: { promptTokens: 900, completionTokens: 200 } }),
      T,
    );
    expect(v.status).toBe('fail');
  });
  it('额度内 → pass', () => {
    const v = budgetEfficiency(
      evidence({ tokenBudget: 1000, usage: { promptTokens: 400, completionTokens: 100 } }),
      T,
    );
    expect(v.status).toBe('pass');
  });
});

describe('阈值安全区间（防止自我修改把闸拧松）', () => {
  it('缺省值等于默认阈值', () => {
    expect(resolveThresholds(null)).toEqual(DEFAULT_L0_THRESHOLDS);
  });

  it('成功率下限被提到 0 也会被夹到安全下限之上', () => {
    const t = resolveThresholds({ minToolSuccessRate: 0 });
    expect(t.minToolSuccessRate).toBeGreaterThanOrEqual(0.2);
  });

  it('拒绝率上限被放到 1.0 也会被夹到安全上限之下', () => {
    const t = resolveThresholds({ maxApprovalRejectionRate: 1 });
    expect(t.maxApprovalRejectionRate).toBeLessThanOrEqual(0.8);
  });

  it('预算上限被放到极大值也会被夹到 1', () => {
    const t = resolveThresholds({ maxBudgetUsageRate: 99 });
    expect(t.maxBudgetUsageRate).toBeLessThanOrEqual(1);
  });

  it('可以合法地收紧（这是允许甚至鼓励的自我强化方向）', () => {
    const t = resolveThresholds({ minToolSuccessRate: 0.9, maxApprovalRejectionRate: 0.1 });
    expect(t.minToolSuccessRate).toBe(0.9);
    expect(t.maxApprovalRejectionRate).toBe(0.1);
  });

  it('非法值（NaN/Infinity）回落到默认阈值，而不是区间下界', () => {
    // 曾出现的缺陷：非法值落到 bounds.min，会把预算上限意外拧到 30% 制造假红。
    // 正确行为是回落到默认值，再在安全区间内 clamp。
    const t = resolveThresholds({
      minToolSuccessRate: Number.NaN,
      maxBudgetUsageRate: Number.POSITIVE_INFINITY,
    });
    expect(t.minToolSuccessRate).toBe(DEFAULT_L0_THRESHOLDS.minToolSuccessRate);
    expect(t.maxBudgetUsageRate).toBe(DEFAULT_L0_THRESHOLDS.maxBudgetUsageRate);
  });
});

describe('判据集合完整性', () => {
  it('L0 恰好 5 条，且判据名唯一', () => {
    expect(L0_CRITERIA).toHaveLength(5);
    const names = new Set<string>();
    for (const fn of L0_CRITERIA) {
      const v = fn(evidence(), T);
      names.add(v.criterion);
      expect(v.layer).toBe('L0');
    }
    expect(names.size).toBe(5);
  });
});
