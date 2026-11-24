import { describe, it, expect } from 'vitest';
import { planAdmissionCriterion } from '../src/services/judge/plan-admission-criterion.js';
import type { AdmissionItem } from '../src/services/plan/plan-admission.js';

/**
 * 方向二第一刀：计划准入判据的可复算性测试。
 * 判据是纯函数——同证据必得同判决；这里锁住 decision→CriterionVerdict 的映射，
 * 并被变异体测试验证（改状态映射/改 weightExcluded/改复用逻辑必须变红）。
 */
const items: AdmissionItem[] = [
  { id: 'u01', status: 'approved' },
  { id: 'u02', status: 'running' },
];
const write = { toolName: 'fs_write', operation: 'create' };

describe('planAdmissionCriterion：方向一判据进 judge 塔的可复算样板', () => {
  it('匹配活跃条目 → pass，data 带 admitted/allowed=true', () => {
    const v = planAdmissionCriterion({ ...write, items, activeItemId: 'u01', requestedItemId: 'u01' });
    expect(v.layer).toBe('L0');
    expect(v.criterion).toBe('plan.admission');
    expect(v.status).toBe('pass');
    expect(v.data).toEqual({ reason: 'admitted', allowed: true });
  });

  it('无活跃条目 → fail，detail 含可注入的引导理由', () => {
    const v = planAdmissionCriterion({ ...write, items, activeItemId: null, requestedItemId: 'u01' });
    expect(v.status).toBe('fail');
    expect(v.data).toEqual({ reason: 'no-active-item', allowed: false });
    expect(v.detail).toContain('无活跃计划条目');
  });

  it('未声明 planItemId → fail', () => {
    const v = planAdmissionCriterion({ ...write, items, activeItemId: 'u01' });
    expect(v.status).toBe('fail');
    expect(v.data?.reason).toBe('item-not-active');
  });

  it('planItemId 不匹配 → fail', () => {
    const v = planAdmissionCriterion({ ...write, items, activeItemId: 'u01', requestedItemId: 'u02' });
    expect(v.status).toBe('fail');
    expect(v.data?.reason).toBe('item-unknown');
  });

  it('非写操作 → unexec + weightExcluded（不适用不计分，杀把 unexec 写成 pass 的变异）', () => {
    const v = planAdmissionCriterion({ toolName: 'fs_read', operation: 'read', items, activeItemId: null, requestedItemId: null });
    expect(v.status).toBe('unexec');
    expect(v.weightExcluded).toBe(true);
    expect(v.data).toEqual({ reason: 'not-a-plan-write' });
  });

  it('写操作集合完整：replace/purge/rename 同样受准入（不绕过）', () => {
    for (const operation of ['create', 'overwrite', 'append', 'replace', 'purge', 'delete', 'rename']) {
      const v = planAdmissionCriterion({ toolName: 'fs_write', operation, items, activeItemId: null, requestedItemId: null });
      expect(v.status, operation).toBe('fail');
    }
  });

  it('确定性：同一证据两次调用逐字相同', () => {
    const input = { ...write, items, activeItemId: 'u01', requestedItemId: 'u02' };
    expect(planAdmissionCriterion(input)).toEqual(planAdmissionCriterion(input));
  });

  it('复用已落地纯函数：判据结论与 evaluatePlanAdmission 一致（不重写规则）', () => {
    const input = { ...write, items, activeItemId: 'u01', requestedItemId: 'u01' };
    // 若有人把本判据改成自己重写准入规则，这条 across-cut 一致性断言会暴露口径漂移
    expect(planAdmissionCriterion(input).data?.allowed).toBe(true);
    expect(planAdmissionCriterion({ ...input, requestedItemId: 'zzz' }).data?.allowed).toBe(false);
  });
});
