/**
 * 判据塔趋势聚合 —— 把判决历史按时间分桶，回答「这一周是在变好还是变差」。
 *
 * 与 insight 的分工：
 *   · insight 是「现在几点了」——当前四层状态、两档分布、深判花费快照；
 *   · stats 是「这段时间走了多远」——按桶的 pass 率 / 平均分 / 覆盖率 / token 消耗。
 * 两者共用同一张 judge_runs 表，但没有任何一项是另一项的重复计算。
 *
 * 聚合放纯函数（buildStats）而不是塞进 SQL：
 *   · 分桶边界、平均分的分母（只算有 score 的行）、深判行与规则行的区分，
 *     都是「口径」问题，写在函数里才能被单测钉死；
 *   · SQL 只负责把这批行按时间捞出来（repository.runsInRange），
 *     读多少行由调用方定上限，不在数据库里做无界聚合。
 */

import type { JudgeRunRow } from '../../repositories/judge.repository.js';
import { decodeSnapshot } from './snapshot-codec.js';

export interface JudgeStatsBucket {
  /** 桶起点（epoch ms）。 */
  t: number;
  runs: number;
  /** parent_run IS NULL 的规则判决数。 */
  rules: number;
  /** 深判派生行数（parent_run 非空）。 */
  deep: number;
  pass: number;
  fail: number;
  inconclusive: number;
  /** 只对有 score 的行取均值；一行都没有时为 null（不是 0）。 */
  avgScore: number | null;
  avgCoverage: number | null;
  promptTokens: number;
  completionTokens: number;
}

export interface JudgeStatsTotals {
  runs: number;
  pass: number;
  fail: number;
  inconclusive: number;
  avgScore: number | null;
  avgCoverage: number | null;
  promptTokens: number;
  completionTokens: number;
}

export interface JudgeStats {
  window: { from: number; to: number; bucketMs: number; days: number };
  buckets: JudgeStatsBucket[];
  totals: JudgeStatsTotals;
  /** 有行但快照缺失/损坏时计一次，便于前端提示「部分历史无 token 数据」。 */
  rowsWithoutSnapshot: number;
}

export interface BuildStatsOptions {
  from: number;
  to: number;
  /** 桶宽（ms）。调用方保证 > 0。 */
  bucketMs: number;
  days: number;
}

const DAY_MS = 86_400_000;

/** 允许的窗口上限：再长就不是趋势而是拖库了。 */
export const MAX_STATS_DAYS = 90;

/** 把天数收敛到 [1, MAX_STATS_DAYS]，并算出桶宽（<=3 天用小时桶，否则天桶）。 */
export function resolveWindow(days: number, now = Date.now()): { from: number; to: number; bucketMs: number; days: number } {
  const safeDays = Math.min(MAX_STATS_DAYS, Math.max(1, Math.floor(Number.isFinite(days) ? days : 7)));
  const bucketMs = safeDays <= 3 ? 3_600_000 : DAY_MS;
  const to = now;
  const from = now - safeDays * DAY_MS;
  return { from, to, bucketMs, days: safeDays };
}

/**
 * 从一行判决的 context_json 里取 usage；旧行/坏快照都按「无快照」计。
 *
 * 注意这里必须走 decodeSnapshot 而不能直接 JSON.parse：
 * 快照是 `gz:` 前缀的 gzip+base64（snapshot-codec 自适应压缩），
 * 直接 parse 会把全部行都当成「无快照」——token 合计恒为 0 且没人能发现。
 */
function tokensOf(row: JudgeRunRow): { prompt: number; completion: number } | null {
  if (!row.context_json) return null;
  const parsed = decodeSnapshot(row.context_json) as {
    context?: { usage?: { promptTokens?: unknown; completionTokens?: unknown } };
  } | null;
  if (!parsed || typeof parsed !== 'object') return null;
  const usage = parsed.context?.usage;
  if (!usage) return null;
  const prompt = Number(usage.promptTokens);
  const completion = Number(usage.completionTokens);
  return {
    prompt: Number.isFinite(prompt) ? prompt : 0,
    completion: Number.isFinite(completion) ? completion : 0,
  };
}

function emptyBucket(t: number): JudgeStatsBucket {
  return {
    t,
    runs: 0,
    rules: 0,
    deep: 0,
    pass: 0,
    fail: 0,
    inconclusive: 0,
    avgScore: null,
    avgCoverage: null,
    promptTokens: 0,
    completionTokens: 0,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * 纯聚合：行 → 分桶趋势。窗口外的行忽略（调用方已按窗口查询，这里再挡一次）。
 *
 * 空桶会被补齐：曲线上的「那天空着」和「那天没数据」是两件事，
 * 前端若拿到不连续的时间轴会把断点连成直线，等于伪造了一段趋势。
 */
export function buildStats(rows: readonly JudgeRunRow[], opts: BuildStatsOptions): JudgeStats {
  const { from, to, bucketMs, days } = opts;
  const width = Math.max(1, Math.floor(bucketMs));
  const firstBucket = Math.floor(from / width) * width;
  const bucketMap = new Map<number, { bucket: JudgeStatsBucket; scoreSum: number; scoreN: number; covSum: number; covN: number }>();
  for (let t = firstBucket; t <= to; t += width) {
    bucketMap.set(t, { bucket: emptyBucket(t), scoreSum: 0, scoreN: 0, covSum: 0, covN: 0 });
  }

  const totals: JudgeStatsTotals = {
    runs: 0,
    pass: 0,
    fail: 0,
    inconclusive: 0,
    avgScore: null,
    avgCoverage: null,
    promptTokens: 0,
    completionTokens: 0,
  };
  let scoreSum = 0;
  let scoreN = 0;
  let covSum = 0;
  let covN = 0;
  let rowsWithoutSnapshot = 0;

  for (const row of rows) {
    if (row.created_at < from || row.created_at > to) continue;
    const t = Math.floor(row.created_at / width) * width;
    const slot = bucketMap.get(t);
    if (!slot) continue;
    const b = slot.bucket;

    b.runs += 1;
    if (row.parent_run === null || row.parent_run === undefined) b.rules += 1;
    else b.deep += 1;
    if (row.verdict === 'pass') b.pass += 1;
    else if (row.verdict === 'fail') b.fail += 1;
    else b.inconclusive += 1;

    // score / coverage：finite 才算一个分母，NaN/Infinity 不得污染均值。
    if (Number.isFinite(row.score)) {
      slot.scoreSum += row.score;
      slot.scoreN += 1;
    }
    if (Number.isFinite(row.coverage)) {
      slot.covSum += row.coverage;
      slot.covN += 1;
    }

    const tokens = tokensOf(row);
    if (tokens === null) {
      rowsWithoutSnapshot += 1;
    } else {
      b.promptTokens += tokens.prompt;
      b.completionTokens += tokens.completion;
    }

    totals.runs += 1;
    if (row.verdict === 'pass') totals.pass += 1;
    else if (row.verdict === 'fail') totals.fail += 1;
    else totals.inconclusive += 1;
    if (Number.isFinite(row.score)) {
      scoreSum += row.score;
      scoreN += 1;
    }
    if (Number.isFinite(row.coverage)) {
      covSum += row.coverage;
      covN += 1;
    }
    if (tokens !== null) {
      totals.promptTokens += tokens.prompt;
      totals.completionTokens += tokens.completion;
    }
  }

  const buckets: JudgeStatsBucket[] = [];
  for (const t of [...bucketMap.keys()].sort((a, b) => a - b)) {
    const slot = bucketMap.get(t)!;
    slot.bucket.avgScore = slot.scoreN > 0 ? round3(slot.scoreSum / slot.scoreN) : null;
    slot.bucket.avgCoverage = slot.covN > 0 ? round3(slot.covSum / slot.covN) : null;
    buckets.push(slot.bucket);
  }

  totals.avgScore = scoreN > 0 ? round3(scoreSum / scoreN) : null;
  totals.avgCoverage = covN > 0 ? round3(covSum / covN) : null;

  return { window: { from, to, bucketMs: width, days }, buckets, totals, rowsWithoutSnapshot };
}