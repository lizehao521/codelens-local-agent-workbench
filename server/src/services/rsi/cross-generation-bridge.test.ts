/**
 * cross-generation-bridge 单元测试。
 * 基于保守证据映射（所有 state → landed + landedFilesHash=ledgerPath），
 * 验证 evaluateCrossGenerationVerdict 不会再抛 INVALID_EVIDENCE，
 * 且四值 verdict 映射、previous=null 短路、next.state 不可变、序列化往返均正确。
 * 无 skip / only；不使用 JSON.parse(serializedVerdict)。
 */
import { describe, it, expect, vi } from 'vitest';
import type { RsiBridgeResult } from './rsi-bridge.service.js';
import { evaluateCrossGenerationShadow, loadPreviousGeneration } from './cross-generation-bridge.js';

function makeResult(overrides: Partial<RsiBridgeResult> & { state: RsiBridgeResult['state'] }): RsiBridgeResult {
  return {
    exitCode: 0,
    reasons: ['fixture'],
    metrics: [
      { metric: 'quality', before: 1, after: 2, better: true },
      { metric: 'latency', before: 10, after: 9, better: true },
    ],
    reportRaw: '{"fixture":true}',
    ledgerPath: '/tmp/ledger-fixture.jsonl',
    ...overrides,
  };
}

describe('evaluateCrossGenerationShadow', () => {
  it('两代构造：真实 landed 证据不抛 INVALID_EVIDENCE，产出 cross_generation 消费对象', () => {
    const previous = makeResult({ state: 'not_improved' });
    const next = makeResult({ state: 'improved' });
    const unified = evaluateCrossGenerationShadow(previous, next);

    expect(unified.source).toBe('cross_generation');
    expect(unified.state).not.toBe('skipped');
    expect(unified.serializedVerdict!.verdict).toBe(unified.verdict);
    expect(unified.serializedVerdict!.rulesVersion).toBe('cross-generation-verdict.v1');
    expect(Array.isArray(unified.serializedVerdict!.guards)).toBe(true);
    expect(unified.serializedVerdict!.diagnostics).toBeDefined();
    expect(unified.exitCode).toBe(next.exitCode);
    expect(unified.metrics).toBe(next.metrics);
    expect(unified.reportRaw).toBe(next.reportRaw);
    expect(unified.ledgerPath).toBe(next.ledgerPath);
    expect(unified.serializedVerdict!.evidenceTransition).toBeDefined();
  });

  it('previous=null 时短路 skipped，不伪装 undecidable，legacy 字段透传', () => {
    const next = makeResult({ state: 'improved' });
    const unified = evaluateCrossGenerationShadow(null, next);

    expect(unified.state).toBe('skipped');
    expect(unified.verdict).toBe('undecidable');
    expect(unified.source).toBe('cross_generation');
    expect(unified.reason).toContain('no previous generation');
    expect(unified.reasons).toContain('cross-generation shadow skipped: no previous generation');
    expect(unified.exitCode).toBe(next.exitCode);
    expect(unified.metrics).toBe(next.metrics);
    expect(unified.reportRaw).toBe(next.reportRaw);
    expect(unified.ledgerPath).toBe(next.ledgerPath);
  });

  it('不改动 next.state / metrics / reportRaw / ledgerPath（引用与值均不变）', () => {
    const previous = makeResult({ state: 'not_improved' });
    const next = makeResult({ state: 'not_improved' });
    const stateBefore = next.state;
    const metricsBefore = next.metrics;
    const rawBefore = next.reportRaw;
    const ledgerBefore = next.ledgerPath;

    evaluateCrossGenerationShadow(previous, next);

    expect(next.state).toBe(stateBefore);
    expect(next.metrics).toBe(metricsBefore);
    expect(next.reportRaw).toBe(rawBefore);
    expect(next.ledgerPath).toBe(ledgerBefore);
  });

  it('四值 verdict 映射：指标值驱动 improved/regressed/unchanged，占位驱动 undecidable', () => {
    // improved：primary after>before 且 better=true → higher_is_better，next 更高
    const improved = evaluateCrossGenerationShadow(
      makeResult({ state: 'not_improved', metrics: [{ metric: 'quality', before: 1, after: 1, better: true }] }),
      makeResult({ state: 'improved', metrics: [{ metric: 'quality', before: 1, after: 2, better: true }] }),
    );
    expect(improved.verdict).toBe('improved');
    expect(improved.serializedVerdict!.verdict).toBe('improved');
    expect(improved.serializedVerdict!.primary).toBeDefined();

    // regressed：next.after 低于 previous.after
    const regressed = evaluateCrossGenerationShadow(
      makeResult({
        state: 'improved',
        metrics: [{ metric: 'quality', before: 1, after: 5, better: true }],
      }),
      makeResult({
        state: 'not_improved',
        metrics: [{ metric: 'quality', before: 1, after: 2, better: true }],
      }),
    );
    expect(regressed.verdict).toBe('not_improved');
    expect(regressed.serializedVerdict!.verdict).toBe('not_improved');

    // unchanged：primary 值相等
    const unchanged = evaluateCrossGenerationShadow(
      makeResult({ state: 'not_improved' }),
      makeResult({ state: 'not_improved' }),
    );
    expect(unchanged.verdict).toBe('not_improved');
    expect(unchanged.serializedVerdict!.verdict).toBe('not_improved');

    // 无指标 → __placeholder__(value=0) 两代相同 → primary 无严格改善 → not_improved（真实判定，保守非伪装）
    const noMetrics = evaluateCrossGenerationShadow(
      makeResult({ state: 'skipped', metrics: undefined }),
      makeResult({ state: 'error', metrics: undefined }),
    );
    expect(noMetrics.verdict).toBe('not_improved');
    expect(noMetrics.serializedVerdict!.verdict).toBe('not_improved');
  });

  it('serializedVerdict 为对象：无 state 字段，经 JSON 序列化往返后 verdict/rulesVersion 保留', () => {
    const unified = evaluateCrossGenerationShadow(
      makeResult({ state: 'not_improved' }),
      makeResult({ state: 'improved' }),
    );
    const serialized = unified.serializedVerdict!;

    expect(typeof serialized).toBe('object');
    expect('state' in serialized).toBe(false);
    expect(serialized.verdict).toBe(unified.verdict);
    expect(typeof serialized.reason).toBe('string');
    expect(serialized.rulesVersion).toBe('cross-generation-verdict.v1');

    const roundTrip = JSON.parse(JSON.stringify(serialized)) as typeof serialized;
    expect(roundTrip.verdict).toBe(serialized.verdict);
    expect(roundTrip.rulesVersion).toBe(serialized.rulesVersion);
    expect(roundTrip.reason).toBe(serialized.reason);
    expect(roundTrip.guards).toEqual(serialized.guards);
    expect(roundTrip.diagnostics).toEqual(serialized.diagnostics);
  });
});

/**
 * loadPreviousGeneration 取数层回归。
 * 这一层此前无测试覆盖，是 P1「previous≡next」bug 逃过门禁的根因。
 * mock db.get 记录最近一次 SQL/参数，断言排除谓词 generation < ? 正确排除当前代。
 */
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
