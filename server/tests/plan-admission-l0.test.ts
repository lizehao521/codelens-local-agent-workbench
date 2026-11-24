/**
 * 方向二落地集成判据：计划准入判据真正注册进 L0 塔，且可被 canary 覆盖。
 * 杀三类变异：①从塔里摘掉第6条 ②适配器恒 pass ③夹具未补 planAdmission。
 */
import { describe, it, expect } from 'vitest';
import { L0_CRITERIA, DEFAULT_L0_THRESHOLDS } from '../src/services/judge/criteria.js';
import { runCanary, CANARY_CASES } from '../src/services/judge/canary.js';

const base = {
  sessionId: 'x',
  finishReason: 'stop',
  iteration: 1,
  tokenBudget: 1000,
  usage: { promptTokens: 0, completionTokens: 0 },
  toolCalls: [],
  approvals: [],
  circuitOpened: false,
};

describe('方向二：计划准入判据注册进 L0 塔', () => {
  it('L0 恰好 6 条，第 6 条是 plan.admission 且能判 pass（杀"未注册"变异）', () => {
    expect(L0_CRITERIA).toHaveLength(6);
    const v = L0_CRITERIA[5]!(
      {
        ...base,
        planAdmission: {
          items: [{ id: 'p1', status: 'approved' }],
          activeItemId: 'p1',
          requestedItemId: 'p1',
          toolName: 'fs_write',
          operation: 'create',
        },
      },
      DEFAULT_L0_THRESHOLDS,
    );
    expect(v.criterion).toBe('plan.admission');
    expect(v.status).toBe('pass');
  });

  it('无 plan 上下文 → unexec + weightExcluded（杀"恒 pass"变异，没证据不假判）', () => {
    const v = L0_CRITERIA[5]!(base, DEFAULT_L0_THRESHOLDS);
    expect(v.status).toBe('unexec');
    expect(v.weightExcluded).toBe(true);
  });

  it('planItemId 不匹配 → fail（判定规则复用，非装饰）', () => {
    const v = L0_CRITERIA[5]!(
      {
        ...base,
        planAdmission: {
          items: [{ id: 'p1', status: 'approved' }],
          activeItemId: 'p1',
          requestedItemId: 'p2',
          toolName: 'fs_write',
          operation: 'create',
        },
      },
      DEFAULT_L0_THRESHOLDS,
    );
    expect(v.status).toBe('fail');
  });

  it('canary 4 夹具都带 planAdmission，GOOD 无 unexec（杀"夹具未补"变异）', () => {
    for (const c of CANARY_CASES) {
      expect(c.evidence.planAdmission, c.name).toBeDefined();
    }
    const out = runCanary(DEFAULT_L0_THRESHOLDS);
    expect(out.verdict.status).toBe('pass');
    // canary 只要求「已知好」样本无 unexec；坏样本允许 unexec。
    const good = out.cases.filter((c) => c.expected === 'good');
    expect(good.length).toBeGreaterThan(0);
    expect(good.every((c) => !c.unexec.includes('plan.admission'))).toBe(true);
  });
});
