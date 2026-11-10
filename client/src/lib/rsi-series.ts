// RSI 通过率序列：从 /api/rsi/overview 的判据结果里提取 task.test_pass_rate，
// 并把「分母（固定评测套件用例数）」变化切成不同基线区间。
// 说明：overview 没有结构化的 passed/total 字段，只能解析 task.test_pass_rate 的
// detail 文本（格式由 server/src/services/judge/eval-rate.ts 生成）；解析不到时如实置空，
// 不猜测分母。

import type { RsiJudgeRun, RsiVerdictRow } from '../services/api';

export const TEST_PASS_RATE = 'task.test_pass_rate';

export interface RsiSuiteResult {
  id: string;
  passed: number;
  total: number;
  error: string | null;
}

export interface BatteryDetail {
  /** 固定评测套件的总通过数 / 总用例数；取不到则为 null */
  passed: number | null;
  total: number | null;
  /** detail 只列出未满分套件；满分套件不会出现在接口里 */
  failing: RsiSuiteResult[];
}

export interface RsiPassPoint {
  runId: number;
  /** 第几次判决（只统计带 task.test_pass_rate 的判决，从 1 开始） */
  index: number;
  createdAt: number;
  score: number;
  status: string;
  detail: string | null;
  passed: number | null;
  total: number | null;
  failing: RsiSuiteResult[];
  /** structured = 来自 verdict.data；detail = 从 detail 文本解析 */
  source: 'structured' | 'detail';
}

export interface RsiBaselineChange {
  /** 新基线在 points 中的下标 */
  atIndex: number;
  from: number;
  to: number;
  /** (to-from)/from，from 为 0 时为 null */
  ratio: number | null;
}

export interface RsiPassSeries {
  points: RsiPassPoint[];
  /** 同一分母的连续区间；分母未知的连续区间也归为一组 */
  segments: RsiPassPoint[][];
  changes: RsiBaselineChange[];
}

/** 解析 detail：「固定评测套件 21/23 通过（含隐藏用例）；未满分：slugify 4/5（err）、json 0/1」。 */
export function parseBatteryDetail(detail: string | null): BatteryDetail {
  if (!detail) return { passed: null, total: null, failing: [] };

  const aggregate = detail.match(/固定评测套件\s*(\d+)\s*\/\s*(\d+)\s*通过/);
  const passed = aggregate ? Number(aggregate[1]) : null;
  const total = aggregate ? Number(aggregate[2]) : null;

  const failing: RsiSuiteResult[] = [];
  const failingPart = detail.split('未满分：')[1];
  if (failingPart) {
    for (const item of failingPart.split('、')) {
      const match = item.trim().match(/^(.+?)\s+(\d+)\s*\/\s*(\d+)(?:（(.+)）)?$/);
      if (!match) continue;
      failing.push({
        id: match[1].trim(),
        passed: Number(match[2]),
        total: Number(match[3]),
        error: match[4]?.trim() || null,
      });
    }
  }
  return { passed, total, failing };
}

/**
 * 构造 task.test_pass_rate 的通过率序列。
 * 优先使用判据的结构化 data（passed/total/denominator/suites）；
 * 旧会话 data 为 null 时回退到 detail 文本解析，并在 point.source 上标明来源。
 */
export function buildPassSeries(
  judgeRuns: RsiJudgeRun[],
  verdictsByRun: Record<number, RsiVerdictRow[]>,
): RsiPassSeries {
  const points: RsiPassPoint[] = [];
  for (const run of judgeRuns) {
    const verdict = (verdictsByRun[run.id] ?? []).find((item) => item.criterion === TEST_PASS_RATE);
    if (!verdict || typeof verdict.score !== 'number') continue;
    const battery = parseBatteryDetail(verdict.detail);
    const structured = verdict.data;
    // 结构化数据以 denominator 为准（分母就是套件用例总数）；拿不到时再退回 total。
    const structuredTotal = structured ? (structured.denominator ?? structured.total) : null;
    const useStructured = structured !== null && (structuredTotal !== null || structured.passed !== null);
    points.push({
      runId: run.id,
      index: points.length + 1,
      createdAt: run.createdAt,
      score: verdict.score,
      status: verdict.status,
      detail: verdict.detail,
      passed: useStructured ? structured.passed : battery.passed,
      total: useStructured ? structuredTotal : battery.total,
      failing: useStructured
        ? structured.suites
            .filter((suite) => !suite.ok)
            .map((suite) => ({
              id: suite.id,
              passed: suite.passed,
              total: suite.total,
              error: suite.error,
            }))
        : battery.failing,
      source: useStructured ? 'structured' : 'detail',
    });
  }

  const segments: RsiPassPoint[][] = [];
  const changes: RsiBaselineChange[] = [];
  for (const point of points) {
    const current = segments[segments.length - 1];
    const key = point.total ?? -1;
    const prevKey = current?.[0]?.total ?? -1;
    if (!current || key !== prevKey) {
      if (current && current[0].total !== null && point.total !== null) {
        changes.push({
          atIndex: points.indexOf(point),
          from: current[0].total,
          to: point.total,
          ratio: current[0].total > 0 ? (point.total - current[0].total) / current[0].total : null,
        });
      }
      segments.push([point]);
    } else {
      current.push(point);
    }
  }

  return { points, segments, changes };
}

/** 最新一条读数（按传入顺序的最后一条）。 */
export function latestPoint(points: RsiPassPoint[]): RsiPassPoint | null {
  return points.length > 0 ? points[points.length - 1] : null;
}
