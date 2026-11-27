/**
 * 判据塔趋势聚合（buildStats / resolveWindow）的单测。
 *
 * 钉死四件事，都是「口径」而非实现细节：
 *  1. 分桶边界：行只落进它所在的那个桶，桶宽决定一切；
 *  2. 空桶补齐：没数据的桶必须存在（runs=0），否则前端会跨空洞连线造假趋势；
 *  3. 均值的分母：只算 finite 的 score/coverage，一行都没有时给 null 而不是 0；
 *  4. token 只来自合法快照：缺失/坏 JSON 计入 rowsWithoutSnapshot，不参与求和。
 */

import { describe, expect, it } from 'vitest';
import { buildStats, resolveWindow, MAX_STATS_DAYS } from '../src/services/judge/stats.js';
import type { JudgeRunRow } from '../src/repositories/judge.repository.js';
import { encodeSnapshot } from '../src/services/judge/snapshot-codec.js';

const DAY = 86_400_000;

function row(over: Partial<JudgeRunRow> & { id: number; created_at: number }): JudgeRunRow {
  return {
    id: over.id,
    session_id: over.session_id ?? 's1',
    verdict: over.verdict ?? 'pass',
    score: over.score ?? 0.8,
    coverage: over.coverage ?? 0.9,
    executed: over.executed ?? 9,
    total: over.total ?? 10,
    context_json: over.context_json === undefined ? null : over.context_json,
    created_at: over.created_at,
    parent_run: over.parent_run ?? null,
  } as JudgeRunRow;
}

/** 用与生产完全相同的编码器造快照：stats 读的必须是同一份编解码。 */
function snapshotWithTokens(prompt: number, completion: number): string {
  return encodeSnapshot({ context: { usage: { promptTokens: prompt, completionTokens: completion } } });
}

describe('resolveWindow', () => {
  const NOW = 1_800_000_000_000;

  it('默认 7 天、天桶', () => {
    const w = resolveWindow(7, NOW);
    expect(w.days).toBe(7);
    expect(w.to).toBe(NOW);
    expect(w.from).toBe(NOW - 7 * DAY);
    expect(w.bucketMs).toBe(DAY);
  });

  it('<=3 天用小时桶', () => {
    expect(resolveWindow(3, NOW).bucketMs).toBe(3_600_000);
    expect(resolveWindow(1, NOW).bucketMs).toBe(3_600_000);
    expect(resolveWindow(4, NOW).bucketMs).toBe(DAY);
  });

  it('越界收敛：0/负数 -> 1 天；超上限 -> MAX_STATS_DAYS；NaN -> 7', () => {
    expect(resolveWindow(0, NOW).days).toBe(1);
    expect(resolveWindow(-5, NOW).days).toBe(1);
    expect(resolveWindow(365, NOW).days).toBe(MAX_STATS_DAYS);
    expect(resolveWindow(Number.NaN, NOW).days).toBe(7);
  });
});

describe('buildStats', () => {
  const NOW = 1_800_000_000_000;
  const window = resolveWindow(7, NOW);

  it('空库：桶全部补齐为 0，totals 全 0，均值 null', () => {
    const stats = buildStats([], window);
    expect(stats.buckets.length).toBeGreaterThan(0);
    for (const b of stats.buckets) {
      expect(b.runs).toBe(0);
      expect(b.avgScore).toBeNull();
      expect(b.avgCoverage).toBeNull();
    }
    expect(stats.totals.runs).toBe(0);
    expect(stats.totals.avgScore).toBeNull();
    expect(stats.rowsWithoutSnapshot).toBe(0);
  });

  it('同一天的行落进同一个桶；pass/fail/inconclusive 分列', () => {
    const t = NOW - 2 * DAY;
    const stats = buildStats(
      [
        row({ id: 1, created_at: t + 1000, verdict: 'pass' }),
        row({ id: 2, created_at: t + 2000, verdict: 'fail' }),
        row({ id: 3, created_at: t + 3000, verdict: 'inconclusive' }),
      ],
      window,
    );
    const nonEmpty = stats.buckets.filter((b) => b.runs > 0);
    expect(nonEmpty).toHaveLength(1);
    expect(nonEmpty[0]!.runs).toBe(3);
    expect(nonEmpty[0]!.pass).toBe(1);
    expect(nonEmpty[0]!.fail).toBe(1);
    expect(nonEmpty[0]!.inconclusive).toBe(1);
    expect(stats.totals.runs).toBe(3);
  });

  it('深判行计入 deep、规则行计入 rules（parent_run 判定）', () => {
    const t = NOW - DAY;
    const stats = buildStats(
      [
        row({ id: 1, created_at: t, parent_run: null }),
        row({ id: 2, created_at: t, parent_run: 1 }),
      ],
      window,
    );
    const b = stats.buckets.find((x) => x.runs > 0)!;
    expect(b.rules).toBe(1);
    expect(b.deep).toBe(1);
  });

  it('均分只算有效值：NaN 不污染分母', () => {
    const t = NOW - DAY;
    const stats = buildStats(
      [
        row({ id: 1, created_at: t, score: 0.4, coverage: 0.5 }),
        row({ id: 2, created_at: t, score: Number.NaN, coverage: Number.NaN }),
        row({ id: 3, created_at: t, score: 0.6, coverage: 0.7 }),
      ],
      window,
    );
    const b = stats.buckets.find((x) => x.runs > 0)!;
    expect(b.avgScore).toBe(0.5);
    expect(b.avgCoverage).toBe(0.6);
  });

  it('token 只来自合法快照；缺失/坏 JSON 计 rowsWithoutSnapshot', () => {
    const t = NOW - DAY;
    const stats = buildStats(
      [
        row({ id: 1, created_at: t, context_json: snapshotWithTokens(100, 20) }),
        row({ id: 2, created_at: t, context_json: null }),
        row({ id: 3, created_at: t, context_json: '{not json' }),
        row({ id: 4, created_at: t, context_json: snapshotWithTokens(50, 5) }),
      ],
      window,
    );
    expect(stats.totals.promptTokens).toBe(150);
    expect(stats.totals.completionTokens).toBe(25);
    expect(stats.rowsWithoutSnapshot).toBe(2);
  });

  it('窗口外的行被忽略', () => {
    const stats = buildStats(
      [
        row({ id: 1, created_at: window.from - 1 }),
        row({ id: 2, created_at: window.to + 1 }),
      ],
      window,
    );
    expect(stats.totals.runs).toBe(0);
  });

  it('桶按时间升序（前端画线不能倒着连）', () => {
    const stats = buildStats([], window);
    for (let i = 1; i < stats.buckets.length; i += 1) {
      expect(stats.buckets[i]!.t).toBeGreaterThan(stats.buckets[i - 1]!.t);
    }
  });
});

describe('gz 压缩快照（生产真实形态）', () => {
  const NOW = 1_800_000_000_000;
  const window = resolveWindow(7, NOW);

  it('gz: 前缀的压缩快照必须能被解出 token（直接 JSON.parse 会全丢）', () => {
    // 编解码器自适应：小快照存明文。生产快照带完整证据，压缩率高才出现 gz:，
    // 这里用重复内容模拟真实形态，确保走的真的是压缩分支。
    const big = encodeSnapshot({
      context: { usage: { promptTokens: 12345, completionTokens: 678 } },
      evidence: { blob: 'x'.repeat(5000) },
    });
    expect(big.startsWith('gz:')).toBe(true);
    const stats = buildStats([row({ id: 1, created_at: NOW - DAY, context_json: big })], window);
    expect(stats.totals.promptTokens).toBe(12345);
    expect(stats.totals.completionTokens).toBe(678);
    expect(stats.rowsWithoutSnapshot).toBe(0);
  });
});
