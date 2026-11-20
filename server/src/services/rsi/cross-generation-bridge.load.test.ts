/**
 * cross-generation-bridge：上一代只读取数单元测试。
 * 覆盖 db 缺失、无上一代、beforeGeneration 排除语义、畸形 JSON 异常隔离。
 */
import { describe, it, expect } from 'vitest';
import { loadPreviousGeneration } from './cross-generation-bridge.js';

describe('loadPreviousGeneration', () => {
  type Row = {
    verdict: string;
    exit_code: number | null;
    reasons_json: string | null;
    metrics_json: string | null;
    ledger_path: string;
  };
  function mockDb(row: Row | undefined) {
    const last = { sql: '', params: [] as Array<string | number | null> };
    const db = {
      get<T>(sql: string, params?: Array<string | number | null>): T | undefined {
        last.sql = sql;
        last.params = params ?? [];
        return row as unknown as T | undefined;
      },
    };
    return { db, last };
  }
  function rowOf(generation: number): Row {
    return {
      verdict: 'not_improved',
      exit_code: 0,
      reasons_json: JSON.stringify([`gen-${generation}`]),
      metrics_json: JSON.stringify([{ metric: 'quality', before: 1, after: generation, better: true }]),
      ledger_path: `/tmp/gen${generation}.jsonl`,
    };
  }

  it('db 为 undefined → null（现有行为回归）', () => {
    expect(loadPreviousGeneration(undefined, 's1')).toBeNull();
    expect(loadPreviousGeneration(undefined, 's1', 3)).toBeNull();
  });

  it('不传 beforeGeneration → SQL 无 generation 谓词，参数仅 sessionId（向后兼容）', () => {
    const { db, last } = mockDb(rowOf(1));
    loadPreviousGeneration(db, 's1');
    expect(last.sql).not.toContain('generation <');
    expect(last.params).toEqual(['s1']);
  });

  it('传 beforeGeneration → SQL 带 generation < ? 且参数含阈值', () => {
    const { db, last } = mockDb(rowOf(4));
    loadPreviousGeneration(db, 's1', 5);
    expect(last.sql).toContain('generation < ?');
    expect(last.params).toEqual(['s1', 5]);
  });

  it('库内仅当前代(gen=1)、beforeGeneration=1 → 无上一代应返回 null', () => {
    // 模拟真实 Db：按 SQL 谓词过滤，而非无条件返回 mock 行
    const rows = [rowOf(1)];
    const db = {
      get<T>(sql: string, params?: Array<string | number | null>): T | undefined {
        const before = params?.[1];
        const picked = typeof before === 'number'
          ? rows.filter((r) => Number(JSON.parse(r.reasons_json!)[0].split('-')[1]) < before).pop()
          : rows[rows.length - 1];
        return picked as unknown as T | undefined;
      },
    };
    expect(loadPreviousGeneration(db, 's1', 1)).toBeNull();
  });

  it('库内 gen=N 与 N+1、beforeGeneration=N+1 → 返回真上一代 N（previous≠current 可证伪）', () => {
    const rows = [rowOf(4), rowOf(5)];
    const db = {
      get<T>(sql: string, params?: Array<string | number | null>): T | undefined {
        const before = params?.[1];
        expect(sql).toContain('generation < ?');
        // 按 generation DESC LIMIT 1 + generation < before 的语义选行
        const picked = rows
          .filter((r) => Number(JSON.parse(r.reasons_json!)[0].split('-')[1]) < (before as number))
          .sort((a, b) => Number(JSON.parse(b.reasons_json!)[0].split('-')[1]) - Number(JSON.parse(a.reasons_json!)[0].split('-')[1]))[0];
        return picked as unknown as T | undefined;
      },
    };
    const prev = loadPreviousGeneration(db, 's1', 5);
    expect(prev).not.toBeNull();
    expect(prev!.reasons).toEqual(['gen-4']);
    expect(prev!.ledgerPath).toBe('/tmp/gen4.jsonl');
    expect(prev!.metrics?.[0]?.after).toBe(4); // ≠ 当前代 5
  });

  it('库内最新为 gen=N（当前代未落库）、beforeGeneration=N+1 → 返回 N（不错取 N-1）', () => {
    const rows = [rowOf(3), rowOf(4)];
    const db = {
      get<T>(sql: string, params?: Array<string | number | null>): T | undefined {
        const before = params?.[1];
        const picked = rows
          .filter((r) => Number(JSON.parse(r.reasons_json!)[0].split('-')[1]) < (before as number))
          .sort((a, b) => Number(JSON.parse(b.reasons_json!)[0].split('-')[1]) - Number(JSON.parse(a.reasons_json!)[0].split('-')[1]))[0];
        return picked as unknown as T | undefined;
      },
    };
    // beforeGeneration=5 而库内最新为 4：应取 4，而非 OFFSET 1 会错取的 3
    expect(loadPreviousGeneration(db, 's1', 5)!.reasons).toEqual(['gen-4']);
  });

  it('解析失败(畸形 JSON) → null，不抛（异常隔离回归）', () => {
    const { db } = mockDb({
      verdict: 'improved', exit_code: 0,
      reasons_json: '{bad json', metrics_json: null, ledger_path: '/tmp/x.jsonl',
    });
    expect(loadPreviousGeneration(db, 's1', 3)).toBeNull();
  });
});
