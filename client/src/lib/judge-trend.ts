/**
 * judge-trend —— 判据塔趋势图的纯几何计算（不 import React，参数进值出）。
 *
 * 与 RsiDashboardModal 里的 PassRateChart 同源思路：不引图表库，
 * 用 viewBox 固定的 SVG 把「桶 → 坐标」算清楚。这里单独成文件是为了可单测：
 *   · null 值必须断线，不能把空洞连成伪造的趋势；
 *   · 单桶时点居中，不除零；
 *   · 纵轴用「值域 0-1」还是「0-max」由调用方给定，本文件只做映射。
 */

import type { JudgeStatsBucket } from '../services/api-judge';

export interface TrendPoint {
  t: number;
  runs: number;
  passRate: number | null;
  avgScore: number | null;
  avgCoverage: number | null;
  promptTokens: number;
  completionTokens: number;
}

/** 一次判决都没有的桶：比率是 null（未知），不是 0（全红）。 */
export function toTrendPoints(buckets: JudgeStatsBucket[]): TrendPoint[] {
  return buckets.map((b) => ({
    t: b.t,
    runs: b.runs,
    passRate: b.runs > 0 ? b.pass / b.runs : null,
    avgScore: b.avgScore,
    avgCoverage: b.avgCoverage,
    promptTokens: b.promptTokens,
    completionTokens: b.completionTokens,
  }));
}

export interface ChartBox {
  width: number;
  height: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
}

export const TREND_BOX: ChartBox = {
  width: 660,
  height: 200,
  padLeft: 44,
  padRight: 16,
  padTop: 18,
  padBottom: 26,
};

/** x 轴：第 index 个点的像素横坐标（单点居中，避免除零）。 */
export function xAt(index: number, count: number, box: ChartBox = TREND_BOX): number {
  const innerW = box.width - box.padLeft - box.padRight;
  if (count <= 1) return box.padLeft + innerW / 2;
  return box.padLeft + (index * innerW) / (count - 1);
}

/** y 轴：把 [0, max] 区间内的值映射成像素纵坐标（0 在底部）。 */
export function yAt(value: number, max: number, box: ChartBox = TREND_BOX): number {
  const innerH = box.height - box.padTop - box.padBottom;
  const safeMax = max > 0 ? max : 1;
  const clamped = Math.max(0, Math.min(safeMax, value));
  return box.padTop + (1 - clamped / safeMax) * innerH;
}

/**
 * 折线路径：null 断线（另起一段），不插值跨空洞。
 * 返回多段 polyline 的 points 字符串数组（每段一条 <polyline>）。
 */
export function lineSegments(
  values: Array<number | null>,
  max: number,
  box: ChartBox = TREND_BOX,
): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (current.length > 0) {
        segments.push(current.join(' '));
        current = [];
      }
      return;
    }
    current.push(`${xAt(index, values.length, box)},${yAt(value, max, box)}`);
  });
  if (current.length > 0) segments.push(current.join(' '));
  return segments;
}

/** 柱状图的每根柱几何（宽度均分，柱间留 2px）。 */
export function bars(
  values: number[],
  max: number,
  box: ChartBox = TREND_BOX,
): Array<{ x: number; y: number; w: number; h: number }> {
  const count = values.length;
  if (count === 0) return [];
  const innerW = box.width - box.padLeft - box.padRight;
  const slot = innerW / count;
  const w = Math.max(1, slot - 2);
  return values.map((value, index) => {
    const x = box.padLeft + index * slot + 1;
    const y = yAt(value, max, box);
    const baseY = yAt(0, max, box);
    return { x, y, w, h: Math.max(0, baseY - y) };
  });
}

/** 时间轴标签：小时桶给 HH:00，天桶给 M/D。 */
export function formatBucketLabel(t: number, bucketMs: number): string {
  const d = new Date(t);
  if (bucketMs < 24 * 3_600_000) {
    return `${String(d.getHours()).padStart(2, '0')}:00`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 千分位紧凑格式（token 量大时避免把卡片撑破）。 */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}