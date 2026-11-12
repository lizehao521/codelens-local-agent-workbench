/**
 * 迭代闸门的展示逻辑判据。
 *
 * ── 为什么前端也要有判据 ──────────────────────────────────
 * 「未执行」在后端已经是三态之一（pass / fail / unexec），但**怎么画到界面上**
 * 没有任何东西守着。最坏的一种情况是有人把 unexec 渲染成绿色——
 * 那就等于在界面上把「没跑」说成「通过」，而用户看的恰恰是界面。
 *
 * 这份判据管的就是这件事：三态必须**分开**，且未执行绝不能落在"通过"那一档。
 * 它同时把筛选逻辑从组件里抽出来——内联在组件里的逻辑没法被这样检验。
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  filterIterations,
  decisionTone,
  statusLabel,
  statusClass,
  type FilterMode,
  type DecisionLike,
} from '../src/lib/iteration-gate-view';

const mk = (decision: string, id = 'x') => ({ id, task: 't', decision });

describe('迭代闸门的展示逻辑', { timeout: 20_000 }, () => {
  it('筛选 all 返回全部', () => {
    const items = [mk('continue'), mk('rollback'), mk('retry')];
    expect(filterIterations(items, 'all' as FilterMode)).toHaveLength(3);
  });

  it('筛选 attention 只留需要人介入的三类', () => {
    const items = [mk('continue'), mk('rollback'), mk('escalate'), mk('halt'), mk('retry')];
    const got = filterIterations(items, 'attention' as FilterMode).map((i) => i.decision);
    expect(got.sort()).toEqual(['escalate', 'halt', 'rollback']);
  });

  it('筛选 ok 只留 continue', () => {
    const items = [mk('continue'), mk('continue'), mk('retry')];
    const got = filterIterations(items, 'ok' as FilterMode);
    expect(got).toHaveLength(2);
    expect(got.every((i) => i.decision === 'continue')).toBe(true);
  });

  it('空列表筛选后仍是空数组，不抛异常', () => {
    expect(filterIterations([], 'attention' as FilterMode)).toEqual([]);
    expect(filterIterations([], 'ok' as FilterMode)).toEqual([]);
  });

  it('金丝雀：未执行的标签必须是「未执行」，绝不能是「通过」', () => {
    // 这条是整份判据的锚点：把 unexec 画成"通过"，等于在界面上撒谎。
    expect(statusLabel('unexec')).not.toBe('通过');
    expect(statusLabel('unexec')).not.toBe('成功');
    expect(statusLabel('unexec')).toBe('未执行');
  });

  it('金丝雀：未执行的样式不得落在成功色上', () => {
    const cls = statusClass('unexec');
    expect(cls).not.toContain('success');
    expect(cls).not.toContain('text-green');
  });

  it('金丝雀：失败与通过的样式必须不同色', () => {
    expect(statusClass('pass')).not.toBe(statusClass('fail'));
    expect(statusClass('pass')).not.toContain('danger');
  });

  it('五种决策都必须有色调，且色调是四值之一', () => {
    const allowed = new Set(['success', 'danger', 'warning', 'muted']);
    for (const d of ['continue', 'retry', 'rollback', 'escalate', 'halt'] as DecisionLike[]) {
      expect(allowed.has(decisionTone(d)), `决策 ${d} 的色调非法`).toBe(true);
    }
  });

  it('回滚与停机必须是危险色，达标继续是成功色', () => {
    expect(decisionTone('rollback')).toBe('danger');
    expect(decisionTone('halt')).toBe('danger');
    expect(decisionTone('continue')).toBe('success');
    expect(decisionTone('retry')).toBe('warning');
    expect(decisionTone('escalate')).toBe('warning');
  });

  it('未知决策不抛异常，回落到中性色', () => {
    expect(decisionTone('no-such-decision')).toBe('muted');
  });

  it('金丝雀：组件必须真的消费这个模块（不能只建模块没人用）', () => {
    // 上一轮七道闸全绿、版本也升了，但围栏只报「新模块被改动」——
    // 组件仍是内联逻辑。判据只测纯函数，就测不到「抽了模块没人用」。
    // 按宣言第 4 节，那不是强化。这条把消费端接线变成机械可验。
    // 用路径而不是 URL：某些沙箱的 fs shim 不接受 URL 对象，会抛
    // "The URL must be of scheme file" —— 那是读取方式的问题，不是组件没接线。
    const src = readFileSync(
      path.join(process.cwd(), 'src', 'components', 'agent', 'RsiIterationGate.tsx'),
      'utf8',
    );
    expect(src).toContain("from '../../lib/iteration-gate-view'");
    expect(src).toContain('filterIterations(');
    expect(src).toContain('decisionTone(');
    expect(src).toContain('statusLabel(');
    expect(src).toContain('statusClass(');
    // 内联映射必须真的被删掉，否则 import 了却没用，等于装饰。
    expect(src).not.toMatch(/const\s+DECISION_TONE\s*[:=]/);
    expect(src).not.toMatch(/const\s+STATUS_CLASS\s*[:=]/);
    expect(src).not.toMatch(/const\s+STATUS_LABEL\s*[:=]/);
  });

  it('金丝雀：面板必须自己轮询，不能只给人看一份快照', () => {
    const src = readFileSync(
      path.join(process.cwd(), 'src', 'components', 'agent', 'RsiIterationGate.tsx'),
      'utf8',
    );
    expect(src).toMatch(/setInterval\(/);
    expect(src).toMatch(/clearInterval\(/);
    expect(src).toContain('5000');
    expect(src).toContain('load(true)');
  });
});
