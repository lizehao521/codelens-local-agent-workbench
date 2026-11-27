/**
 * 判据塔趋势图的几何判据。
 *
 * 图表最容易「说谎」的两个地方，正是这里要钉死的：
 *   1. 空洞连线 —— 没有判决的那天不能连成趋势（必须断线）；
 *   2. 分母混淆 —— runs=0 的桶是「未知」，不是「0% 通过」。
 * SVG 的像素级效果不在本文件射程内，这里只管「坐标算得对不对」。
 */

import { describe, expect, it } from 'vitest';
import {
  TREND_BOX,
  bars,
  compactNumber,
  formatBucketLabel,
  lineSegments,
  toTrendPoints,
  xAt,
  yAt,
} from '../src/lib/judge-trend';
import type { JudgeStatsBucket } from '../src/services/api-judge';

function bucket(over: Partial<JudgeStatsBucket> = {}): JudgeStatsBucket {
  return {
    t: 1_800_000_000_000,
    runs: 4,
    rules: 3,
    deep: 1,
    pass: 3,
    fail: 1,
    inconclusive: 0,
    avgScore: 0.75,
    avgCoverage: 0.9,
    promptTokens: 100,
    completionTokens: 20,
    ...over,
  };
}

describe('toTrendPoints', () => {
  it('runs=0 的桶通过率为 null（未知），不是 0', () => {
    const [p] = toTrendPoints([bucket({ runs: 0, pass: 0, fail: 0, avgScore: null })]);
    expect(p!.passRate).toBeNull();
    expect(p!.avgScore).toBeNull();
  });

  it('通过率 = pass / runs；token 透传', () => {
    const [p] = toTrendPoints([bucket({ runs: 4, pass: 3 })]);
    expect(p!.passRate).toBe(0.75);
    expect(p!.promptTokens).toBe(100);
  });
});

describe('xAt / yAt', () => {
  it('单点居中，不除零', () => {
    const x = xAt(0, 1);
    expect(x).toBe(TREND_BOX.padLeft + (TREND_BOX.width - TREND_BOX.padLeft - TREND_BOX.padRight) / 2);
  });

  it('多点均匀铺满绘图区', () => {
    expect(xAt(0, 3)).toBe(TREND_BOX.padLeft);
    expect(xAt(2, 3)).toBe(TREND_BOX.width - TREND_BOX.padRight);
  });

  it('yAt：0 在底部，max 在顶部，越界被夹住', () => {
    expect(yAt(0, 1)).toBe(TREND_BOX.height - TREND_BOX.padBottom);
    expect(yAt(1, 1)).toBe(TREND_BOX.padTop);
    expect(yAt(-5, 1)).toBe(yAt(0, 1));
    expect(yAt(99, 1)).toBe(yAt(1, 1));
  });

  it('yAt：max=0 不除零，全部落到基线', () => {
    expect(Number.isFinite(yAt(0, 0))).toBe(true);
  });
});

describe('lineSegments', () => {
  it('null 断线：空洞两侧各成一段，绝不跨洞连线', () => {
    const segs = lineSegments([0.5, null, 0.8], 1);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toContain(',');
    expect(segs[1]).toContain(',');
  });

  it('全 null → 无段（不画线）', () => {
    expect(lineSegments([null, null, null], 1)).toEqual([]);
  });

  it('单点成段（能被 polyline 渲染成不可见段，但不应崩）', () => {
    expect(lineSegments([0.3], 1)).toHaveLength(1);
  });
});

describe('bars', () => {
  it('零值柱高度为 0；最大值柱顶到 padTop', () => {
    const rects = bars([0, 10], 10);
    expect(rects).toHaveLength(2);
    expect(rects[0]!.h).toBe(0);
    expect(rects[1]!.h).toBeGreaterThan(0);
    expect(rects[1]!.y).toBeCloseTo(TREND_BOX.padTop, 5);
  });

  it('空数据无柱', () => {
    expect(bars([], 1)).toEqual([]);
  });
});

describe('formatBucketLabel', () => {
  it('小时桶给 HH:00，天桶给 M/D', () => {
    const d = new Date(2026, 10, 27, 9, 30, 0); // 2026-11-27 09:30 本地
    expect(formatBucketLabel(d.getTime(), 3_600_000)).toBe('09:00');
    expect(formatBucketLabel(d.getTime(), 86_400_000)).toBe('11/27');
  });
});

describe('compactNumber', () => {
  it('千分位压缩', () => {
    expect(compactNumber(999)).toBe('999');
    expect(compactNumber(1500)).toBe('1.5k');
    expect(compactNumber(2_400_000)).toBe('2.4M');
    expect(compactNumber(Number.NaN)).toBe('0');
  });
});