/**
 * lessons per-lesson status：status 优先淘汰的纯函数自证（P0 缺口落地）。
 * 证明被标记 superseded/contradicted 的经验在超限时先于 passRate/FIFO 被丢，
 * 且缺省（无 status）时行为与旧逻辑完全一致（向后兼容）。
 */
import { describe, it, expect } from 'vitest';
import { evictMarkedLessons } from '../src/services/agent/lesson-status.js';

describe('evictMarkedLessons：status 优先淘汰', () => {
  it('无 status 时行为不变（向后兼容）', () => {
    const lessons = ['a', 'b', 'c'];
    const r = evictMarkedLessons(lessons, 1, undefined);
    expect(r.lessons).toEqual(lessons);
    expect(r.overflow).toBe(1);
  });

  it('全 active 时行为不变', () => {
    const lessons = ['a', 'b', 'c'];
    const r = evictMarkedLessons(lessons, 1, { a: 'active', b: 'active', c: 'active' });
    expect(r.lessons).toEqual(lessons);
    expect(r.overflow).toBe(1);
  });

  it('被标记 superseded/contradicted 的经验优先被淘汰', () => {
    const lessons = ['good', 'stale', 'wrong'];
    const r = evictMarkedLessons(lessons, 2, { good: 'active', stale: 'superseded', wrong: 'contradicted' });
    // 两条 marked 先丢，溢出归零
    expect(r.lessons).toEqual(['good']);
    expect(r.overflow).toBe(0);
  });

  it('overflow 小于 marked 数量时只丢前几条，剩余 overflow 交回调用方', () => {
    const lessons = ['a', 'b', 'c'];
    const r = evictMarkedLessons(lessons, 1, { a: 'superseded', b: 'contradicted' });
    // 只丢 1 条 marked，仍剩 1 条 marked + overflow 归零
    expect(r.lessons).toEqual(['b', 'c']);
    expect(r.overflow).toBe(0);
  });

  it('marked 少于 overflow 时，余量交回调用方走 passRate/FIFO', () => {
    const lessons = ['a', 'b', 'c', 'd'];
    const r = evictMarkedLessons(lessons, 3, { a: 'contradicted' });
    // 丢 1 条 marked，还剩 2 条要淘汰
    expect(r.lessons).toEqual(['b', 'c', 'd']);
    expect(r.overflow).toBe(2);
  });

  it('不改变原数组（纯函数无副作用）', () => {
    const lessons = ['a', 'b'];
    evictMarkedLessons(lessons, 1, { a: 'superseded' });
    expect(lessons).toEqual(['a', 'b']);
  });
});
