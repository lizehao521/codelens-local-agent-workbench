/**
 * exp172 验收线：逐代只读回读（generation-diff-readback）。
 *
 * 守四件事：
 *   ① 表缺失返回空且绝不建表（只读入口在类型上就没有 exec/run）；
 *   ② 四种持久化状态不被折叠，截断不被并入 complete；
 *   ③ 按代读取不取最新代、无行不虚构 not_attempted；
 *   ④ 查询故障与非法行值必须抛，不得伪装成「未采集」。
 */
import { describe, it, expect } from 'vitest';
import { createDb } from '../../repositories/db.js';
import { RSI_DIFF_SCHEMA_SQL } from './generation-diff.schema.js';
import {
  readGenerationDiffStats,
  readGenerationDiffStat,
  summarizeGenerationDiffStats,
} from './generation-diff-readback.js';

type Db = ReturnType<typeof createDb>;

function makeDb(): Db {
  const db = createDb(':memory:');
  db.exec(RSI_DIFF_SCHEMA_SQL);
  return db;
}

interface RowOpts {
  readonly id: number;
  readonly gen: number;
  readonly status: string;
  readonly sid?: string;
  readonly truncated?: number;
  readonly covered?: number;
  readonly invalidArgs?: number;
  readonly meta?: number;
  readonly origin?: string | null;
  readonly blind?: string | null;
  readonly bytes?: number;
}

function addRow(db: Db, o: RowOpts): void {
  db.run(
    `INSERT INTO rsi_generation_diff
       (policy_rsi_run_id, session_id, generation, status, aggregate_text, text_bytes,
        text_truncated, events_json, covered_writes, blind_spots_json, invalid_args_count,
        metadata_only, origin, source_window_t0, source_window_t1, schema_version,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, 'SECRET-BODY', ?, ?, '[]', ?, ?, ?, ?, ?, 100, 200, 1, 0, 0)`,
    [
      o.id,
      o.sid ?? 's-1',
      o.gen,
      o.status,
      o.bytes ?? 10,
      o.truncated ?? 0,
      o.covered ?? 1,
      o.blind ?? '[]',
      o.invalidArgs ?? 0,
      o.meta ?? 0,
      o.origin ?? 'tool_calls',
    ],
  );
}

describe('generation-diff-readback', () => {
  it('表缺失：返回空、按代为 null，且全程不建表', () => {
    const db = createDb(':memory:');
    // 只暴露 get/all 的视图：实现若试图 exec/run，会在此抛 TypeError。
    const ro = { get: db.get.bind(db), all: db.all.bind(db) };

    expect(readGenerationDiffStats(ro, 's-1')).toEqual([]);
    expect(readGenerationDiffStat(ro, 's-1', 1)).toBeNull();
    expect(
      db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rsi_generation_diff'`),
    ).toBeUndefined();
  });

  it('四状态各一行 + 另一会话：不折叠、不串会话、严格升序', () => {
    const db = makeDb();
    addRow(db, { id: 1, gen: 3, status: 'not_attempted' });
    addRow(db, { id: 2, gen: 1, status: 'complete', origin: 'checkpoint', blind: '[]' });
    addRow(db, { id: 3, gen: 2, status: 'partial', truncated: 1, blind: '["sys_exec:git","mcp:x"]' });
    addRow(db, { id: 4, gen: 4, status: 'unavailable', covered: 0 });
    addRow(db, { id: 5, gen: 1, status: 'complete', sid: 's-2' });

    const rows = readGenerationDiffStats(db, 's-1');
    expect(rows.map((r) => r.generation)).toEqual([1, 2, 3, 4]);
    expect(rows.map((r) => r.status)).toEqual(['complete', 'partial', 'not_attempted', 'unavailable']);
    expect(rows[1]?.textTruncated).toBe(true);
    expect(rows[1]?.blindSpotsCount).toBe(2);

    // 正文绝不外流：返回对象里不存在 aggregateText / diffText 键。
    for (const r of rows) {
      expect(Object.keys(r)).not.toContain('aggregateText');
      expect(JSON.stringify(r)).not.toContain('SECRET-BODY');
    }

    const summary = summarizeGenerationDiffStats(rows);
    expect(summary.recordedGenerations).toBe(4);
    expect(summary.completeCount).toBe(1);
    expect(summary.partialCount).toBe(1);
    expect(summary.unavailableCount).toBe(1);
    expect(summary.notAttemptedCount).toBe(1);
    expect(summary.truncatedCount).toBe(1);
    expect(summary.coveredWritesSum).toBe(3);
    expect(summary.blindSpotsSum).toBe(2);
  });

  it('按代读取：非最新代可读，无行代返回 null', () => {
    const db = makeDb();
    addRow(db, { id: 1, gen: 2, status: 'complete' });
    addRow(db, { id: 2, gen: 5, status: 'partial' });

    expect(readGenerationDiffStat(db, 's-1', 2)?.status).toBe('complete');
    expect(readGenerationDiffStat(db, 's-1', 99)).toBeNull();
    expect(readGenerationDiffStat(db, 's-1', 2)?.window).toEqual({ t0: 100, t1: 200 });
  });

  it('摘要与 SQL 聚合逐字段相等', () => {
    const db = makeDb();
    addRow(db, { id: 1, gen: 1, status: 'complete', covered: 2 });
    addRow(db, { id: 2, gen: 2, status: 'partial', truncated: 1, blind: '["a"]' });
    addRow(db, { id: 3, gen: 3, status: 'unavailable', covered: 0, invalidArgs: 3 });

    const s = summarizeGenerationDiffStats(readGenerationDiffStats(db, 's-1'));
    const q = db.get<Record<string, number | null>>(
      `SELECT COUNT(*) AS rg,
              SUM(status = 'complete') AS c, SUM(status = 'partial') AS p,
              SUM(status = 'unavailable') AS u, SUM(status = 'not_attempted') AS n,
              SUM(text_truncated <> 0) AS tr, SUM(metadata_only) AS mo,
              SUM(covered_writes) AS cw, SUM(invalid_args_count) AS ia
         FROM rsi_generation_diff WHERE session_id = 's-1'`,
    )!;
    expect(s).toMatchObject({
      recordedGenerations: q.rg,
      completeCount: q.c,
      partialCount: q.p,
      unavailableCount: q.u,
      notAttemptedCount: q.n,
      truncatedCount: q.tr,
      metadataOnlyCount: q.mo,
      coveredWritesSum: q.cw,
      invalidArgsCountSum: q.ia,
    });
  });

  it('查询故障与非法行值必须抛，不得当成未采集', () => {
    const broken = {
      get: () => ({ name: 'rsi_generation_diff' }),
      all: () => {
        throw new Error('db down');
      },
    };
    expect(() => readGenerationDiffStats(broken as never, 's-1')).toThrow(/db down/);

    // 裸表没有 CHECK：写入非法 status 后必须被映射层拒绝，而不是被读成某种已知状态。
    const badStatus = createDb(':memory:');
    badStatus.exec(`CREATE TABLE rsi_generation_diff (
      policy_rsi_run_id INTEGER PRIMARY KEY, session_id TEXT, generation INTEGER, status TEXT,
      text_bytes INTEGER, text_truncated INTEGER, covered_writes INTEGER,
      invalid_args_count INTEGER, metadata_only INTEGER, origin TEXT,
      source_window_t0 INTEGER, source_window_t1 INTEGER, blind_spots_json TEXT)`);
    badStatus.run(
      `INSERT INTO rsi_generation_diff VALUES (1, 's-1', 1, 'weird', 0, 0, 0, 0, 0, NULL, NULL, NULL, '[]')`,
    );
    expect(() => readGenerationDiffStats(badStatus, 's-1')).toThrow(/invalid status/);

    const badBlind = makeDb();
    badBlind.run(
      `INSERT INTO rsi_generation_diff
         (policy_rsi_run_id, session_id, generation, status, blind_spots_json, created_at, updated_at)
       VALUES (1, 's-1', 1, 'complete', '{"not":"array"}', 0, 0)`,
    );
    expect(() => readGenerationDiffStats(badBlind, 's-1')).toThrow(/blind_spots_json/);
  });
});
