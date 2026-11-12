/**
 * root-probe —— 只给 `tool-test-run-project-root.test.ts` 用的夹具。
 *
 * 为什么不复用 `probe.test.ts`：那个夹具会写 `.mode-fail` / `.mode-slow` 标记文件，
 * 两条判据并发跑同一夹具时会互相改状态，出现「单跑绿、并发红」的假失败。
 * 这里只做恒定断言，不碰文件系统。
 *
 * 名字故意不叫 `*.test.ts` 之外的变体，也不放进数字计数类判据的扫描范围。
 */

import { describe, expect, it } from 'vitest';

describe('root-probe', () => {
  it('A 算术恒定', () => {
    expect(1 + 1).toBe(2);
  });

  it('B 字符串恒定', () => {
    expect('rsi'.toUpperCase()).toBe('RSI');
  });

  it('C 数组长度恒定', () => {
    expect([1, 2, 3].length).toBe(3);
  });

  it('D 对象键恒定', () => {
    expect(Object.keys({ a: 1, b: 2 }).sort()).toEqual(['a', 'b']);
  });
});
