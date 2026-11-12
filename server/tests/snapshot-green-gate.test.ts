/**
 * 「判据把现状写成了期望」这条闸的判据。
 *
 * 现场（2026-11-12 第四轮，fs-read-maxbytes-default-mismatch）：
 * 判据里同时有
 *   it('不传 maxBytes → 现在会在 16KB 截断')  expect(truncated).toBe(true)   ← 基线上绿
 *   it('显式 maxBytes=262144 → 读全量')      expect(truncated).toBe(false)  ← 基线上红
 * 整体判定是「有红有绿 → 真红」，于是它被采纳了；可这题**永远无解**：
 * 修好默认值第一条红，不修第二条红。Agent 会被派 3 次、每次记「行为不对」。
 *
 * 逐条看的结果才暴露矛盾：模型写的断言里，有在基线上就绿的 —— 那是在给 bug 拍照。
 * 模板追加的安全断言（导出面 / 注册表 / 越界拒绝）本来就该绿，必须排除，否则每道题都被拒。
 */

import { describe, expect, it } from 'vitest';
import { snapshotGreens } from '../scripts/auto-adopt.js';

const rows = [
  { title: '不传 maxBytes → 现在会在 16KB 截断', status: 'passed', safety: false },
  { title: '显式 maxBytes=262144 → 读全量', status: 'failed', safety: false },
  { title: '必须导出命名约定的对象', status: 'passed', safety: true },
  { title: '必须注册进 BUILTIN_TOOLS', status: 'passed', safety: true },
];

describe('snapshotGreens', () => {
  it('挑出基线上绿的模型断言（就是在给 bug 拍照）', () => {
    expect(snapshotGreens(rows)).toEqual(['不传 maxBytes → 现在会在 16KB 截断']);
  });

  it('模板安全断言的绿不算 —— 否则每道题都会被误拒', () => {
    const onlySafety = rows.filter((r) => r.safety);
    expect(snapshotGreens(onlySafety)).toEqual([]);
  });

  it('全红 → 无快照（健康的缺陷题）', () => {
    const allRed = rows.map((r) => ({ ...r, status: 'failed' }));
    expect(snapshotGreens(allRed)).toEqual([]);
  });

  it('金丝雀：红的那条不会被误报成快照', () => {
    expect(snapshotGreens(rows)).not.toContain('显式 maxBytes=262144 → 读全量');
  });
});
