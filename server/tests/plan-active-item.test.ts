import { describe, it, expect } from 'vitest';
import { selectActiveItem, type PlanView } from '../src/services/plan/plan.service.js';

/**
 * selectActiveItem 判定纯函数（方向一第二刀）——表驱动 + 变异体可杀。
 * 覆盖判决要求的三条路径：选中唯一 / 并列确定性 tie-break / 全无返回 null。
 */
function pv(id: string, status: PlanView['status'], updatedAt = 100, createdAt = 100): PlanView {
  return {
    id,
    sessionId: 's1',
    runId: null,
    title: id,
    status,
    steps: [],
    createdAt,
    updatedAt,
  };
}

describe('selectActiveItem：当前活跃条目的确定性派生', () => {
  it('只有 approved 一条 → 选中它', () => {
    const list = [pv('d1', 'draft'), pv('a1', 'approved'), pv('x1', 'cancelled')];
    expect(selectActiveItem(list)?.id).toBe('a1');
  });

  it('只有 running 一条 → 选中它', () => {
    const list = [pv('d1', 'done'), pv('r1', 'running'), pv('d2', 'draft')];
    expect(selectActiveItem(list)?.id).toBe('r1');
  });

  it('approved 与 running 并存 → 按 updatedAt 大者选中（固定 tie-break）', () => {
    const list = [pv('a1', 'approved', 100), pv('r1', 'running', 200)];
    expect(selectActiveItem(list)?.id).toBe('r1');
  });

  it('updatedAt 相同 → 按 createdAt 大者选中', () => {
    const list = [pv('a1', 'approved', 100, 50), pv('r1', 'running', 100, 80)];
    expect(selectActiveItem(list)?.id).toBe('r1');
  });

  it('updatedAt/createdAt 都相同 → 按 id 字典序小者选中（全序、确定性）', () => {
    const list = [pv('z1', 'running', 100, 100), pv('a1', 'approved', 100, 100), pv('m1', 'running', 100, 100)];
    expect(selectActiveItem(list)?.id).toBe('a1');
  });

  it('候选顺序颠倒 → 结果不变（不依赖输入顺序）', () => {
    const a = [pv('z1', 'running', 100, 100), pv('a1', 'approved', 100, 100)];
    const b = [pv('a1', 'approved', 100, 100), pv('z1', 'running', 100, 100)];
    expect(selectActiveItem(a)?.id).toBe(selectActiveItem(b)?.id);
  });

  it('全 draft/done/cancelled → 返回 null（杀"忽略状态过滤"变异体）', () => {
    const list = [pv('d1', 'draft'), pv('x1', 'done'), pv('c1', 'cancelled')];
    expect(selectActiveItem(list)).toBeNull();
  });

  it('空列表 → 返回 null（杀"空列表不返回 null"变异体）', () => {
    expect(selectActiveItem([])).toBeNull();
  });

  it('确定性：同一列表两次调用选中同一条', () => {
    const list = [pv('z1', 'running', 100, 100), pv('a1', 'approved', 100, 100)];
    expect(selectActiveItem(list)?.id).toBe(selectActiveItem(list)?.id);
  });
});
