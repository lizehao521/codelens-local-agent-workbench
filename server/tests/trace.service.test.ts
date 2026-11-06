/**
 * TraceService 集成测试：运行轨迹的记录与查询。
 *
 * 三组关注点：
 *  1. 正常路径：start → record(act/judge/update) → end → list / getSpans 口径一致；
 *  2. 边界：limit 的收敛（非法 → 默认 50、超上限 → 200）、空库；
 *  3. 降级：观测面不能成为新的故障点 —— 未启用 / 未知 traceId / 非法 kind
 *     一律不抛错，且不写脏数据。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { TraceService, type TraceSpanKind } from '../src/services/observability/trace.service.js';
import { TracesController } from '../src/controllers/traces.controller.js';

let db: Db;
let service: TraceService;

beforeEach(() => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  service = new TraceService({ db, enabled: true });
});

afterEach(() => {
  vi.useRealTimers();
});

/** 轨迹行里的 span_count（直接查库，验证服务返回的口径与库内一致）。 */
function spanCountOf(traceId: string): number {
  const row = db.get<{ span_count: number }>(`SELECT span_count FROM agent_traces WHERE id = ?`, [
    traceId,
  ]);
  return row?.span_count ?? -1;
}

function spanRowsOf(traceId: string): number {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM agent_trace_spans WHERE trace_id = ?`,
    [traceId],
  );
  return row?.n ?? -1;
}

describe('TraceService 正常路径', () => {
  it('start → record 多个 span → end → list 与 getSpans 口径一致', () => {
    const trace = service.startTrace('sess-1', 'agent-loop');
    expect(trace).not.toBeNull();
    expect(trace?.status).toBe('running');
    expect(trace?.spanCount).toBe(0);
    expect(trace?.endedAt).toBeUndefined();

    const act = service.recordSpan(trace!.traceId, {
      kind: 'act',
      name: 'fs.read',
      status: 'ok',
      detail: '读取 config.ts',
      durationMs: 12,
    });
    const judge = service.recordSpan(trace!.traceId, {
      kind: 'judge',
      name: 'judge.runs',
      status: 'ok',
      durationMs: 300,
    });
    const update = service.recordSpan(trace!.traceId, {
      kind: 'update',
      name: 'policy.update',
      status: 'error',
      detail: '注入预算不足',
      durationMs: 5,
    });
    expect(act).not.toBeNull();
    expect(judge).not.toBeNull();
    expect(update).not.toBeNull();

    service.endTrace(trace!.traceId, 'ok');

    const list = service.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.traceId).toBe(trace!.traceId);
    expect(list[0]?.sessionId).toBe('sess-1');
    expect(list[0]?.rootName).toBe('agent-loop');
    expect(list[0]?.status).toBe('ok');
    expect(list[0]?.spanCount).toBe(3);
    expect(list[0]?.endedAt).toBeGreaterThan(0);

    const spans = service.getSpans(trace!.traceId);
    expect(spans).toHaveLength(3);
    // 顺序即发生顺序（seq 升序）。
    expect(spans.map((s) => s.kind)).toEqual(['act', 'judge', 'update']);
    expect(spans.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(spans[0]?.name).toBe('fs.read');
    expect(spans[0]?.detail).toBe('读取 config.ts');
    expect(spans[0]?.durationMs).toBe(12);
    expect(spans[1]?.durationMs).toBe(300);
    expect(spans[2]?.status).toBe('error');
    expect(spans[2]?.detail).toBe('注入预算不足');
  });

  it('seq 自增维护，span_count 与实际 span 条数始终一致', () => {
    const trace = service.startTrace('sess-2', 'loop')!;

    for (let i = 0; i < 5; i += 1) {
      const span = service.recordSpan(trace.traceId, { kind: 'act', name: `tool-${i}` });
      expect(span?.seq).toBe(i + 1);
    }

    // 服务返回值、库内 span_count、库内实际行数三者必须是同一个数。
    expect(service.list()[0]?.spanCount).toBe(5);
    expect(spanCountOf(trace.traceId)).toBe(5);
    expect(spanRowsOf(trace.traceId)).toBe(5);
  });

  it('list 按 started_at DESC 排序（新的在前）', () => {
    vi.useFakeTimers();
    const base = Date.parse('2024-01-01T00:00:00.000Z');

    vi.setSystemTime(base);
    const first = service.startTrace('sess-3', 'first')!;
    vi.setSystemTime(base + 1_000);
    const second = service.startTrace('sess-3', 'second')!;
    vi.setSystemTime(base + 2_000);
    const third = service.startTrace('sess-3', 'third')!;

    const ids = service.list().map((t) => t.traceId);
    expect(ids).toEqual([third.traceId, second.traceId, first.traceId]);
  });

  it('未结束的轨迹不带 endedAt，结束的轨迹带 endedAt', () => {
    const running = service.startTrace('sess-4', 'still-running')!;
    const done = service.startTrace('sess-4', 'done')!;
    service.endTrace(done.traceId, 'error');

    const byId = new Map(service.list().map((t) => [t.traceId, t]));
    expect(byId.get(running.traceId)?.status).toBe('running');
    expect(byId.get(running.traceId)?.endedAt).toBeUndefined();
    expect(byId.get(done.traceId)?.status).toBe('error');
    expect(typeof byId.get(done.traceId)?.endedAt).toBe('number');
  });

  it('埋点发生在外层事务内也能正确写入（agent-loop 可能带着事务调 recordSpan）', () => {
    const trace = service.startTrace('sess-nested', 'nested')!;

    // recordSpan 内部自己开事务；被外层事务包住时走 SAVEPOINT 嵌套路径。
    const span = db.transaction(() => service.recordSpan(trace.traceId, { kind: 'act', name: 'in-tx' }));

    expect(span?.seq).toBe(1);
    expect(spanCountOf(trace.traceId)).toBe(1);
    expect(spanRowsOf(trace.traceId)).toBe(1);
    expect(service.getSpans(trace.traceId)).toHaveLength(1);
  });

  it('外层事务回滚时，span 与 span_count 一起回滚（不留半行）', () => {
    const trace = service.startTrace('sess-rollback', 'rollback')!;

    try {
      db.transaction(() => {
        service.recordSpan(trace.traceId, { kind: 'act', name: 'doomed' });
        throw new Error('boom');
      });
    } catch {
      // 预期抛出：外层事务被回滚。
    }

    expect(spanRowsOf(trace.traceId)).toBe(0);
    expect(spanCountOf(trace.traceId)).toBe(0);
  });
});

describe('TraceService 边界（limit 收敛只在一处）', () => {
  it('limit 非法（0 / 负数 / NaN / 缺省）→ 回落默认 50', () => {
    for (let i = 0; i < 55; i += 1) service.startTrace('sess-limit', `t${i}`);

    expect(service.list(0)).toHaveLength(50);
    expect(service.list(-1)).toHaveLength(50);
    expect(service.list(Number.NaN)).toHaveLength(50);
    expect(service.list(undefined)).toHaveLength(50);
    expect(service.list()).toHaveLength(50);
  });

  it('limit 超上限 → 被 clamp 到 200', () => {
    for (let i = 0; i < 55; i += 1) service.startTrace('sess-limit', `t${i}`);

    expect(service.list(999)).toHaveLength(55);
    expect(service.list(200)).toHaveLength(55);
    // 上限本身也要生效：60 条时 list(200) 只能拿 55 条（库里只有 55 条）。
    expect(service.list(1)).toHaveLength(1);
    expect(service.list(30)).toHaveLength(30);
  });

  it('limit 以字符串形态进来也走同一套收敛（非法 → 默认）', () => {
    for (let i = 0; i < 55; i += 1) service.startTrace('sess-limit', `t${i}`);

    expect(service.list('abc' as unknown as number)).toHaveLength(50);
    expect(service.list('10' as unknown as number)).toHaveLength(10);
  });

  it('空库 list → 空数组，getSpans → 空数组', () => {
    expect(service.list()).toEqual([]);
    expect(service.list(10)).toEqual([]);
    expect(service.getSpans('not-exist')).toEqual([]);
  });

  it('缺省的 detail / durationMs 有稳定默认值', () => {
    const trace = service.startTrace('sess-5', 'defaults')!;
    const span = service.recordSpan(trace.traceId, { kind: 'act', name: 'noop' });

    expect(span?.detail).toBeUndefined();
    expect(span?.durationMs).toBe(0);
    expect(span?.status).toBe('ok');
  });

  it('负耗时被归一为 0（不写负数进库）', () => {
    const trace = service.startTrace('sess-5', 'neg')!;
    const span = service.recordSpan(trace.traceId, { kind: 'act', name: 'x', durationMs: -5 });

    expect(span?.durationMs).toBe(0);
    const rows = db.all<{ duration_ms: number }>(
      `SELECT duration_ms FROM agent_trace_spans WHERE trace_id = ?`,
      [trace.traceId],
    );
    expect(rows[0]?.duration_ms).toBe(0);
  });
});

describe('TraceService 降级（观测面不得成为故障点）', () => {
  it('未启用：startTrace / recordSpan 返回 null，list / getSpans 返回空数组', () => {
    const off = new TraceService({ db, enabled: false });

    expect(off.enabled).toBe(false);
    expect(off.startTrace('sess-off', 'loop')).toBeNull();
    expect(off.recordSpan('whatever', { kind: 'act', name: 'x' })).toBeNull();
    expect(off.list()).toEqual([]);
    expect(off.getSpans('whatever')).toEqual([]);
  });

  it('未启用：endTrace 不抛错', () => {
    const off = new TraceService({ db, enabled: false });
    expect(() => off.endTrace('whatever', 'ok')).not.toThrow();
  });

  it('未启用时不写任何行', () => {
    const off = new TraceService({ db, enabled: false });
    off.startTrace('sess-off', 'loop');
    off.recordSpan('whatever', { kind: 'act', name: 'x' });

    const traces = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_traces`);
    expect(traces?.n ?? -1).toBe(0);
  });

  it('未知 traceId：recordSpan 返回 null，且不写库不抛错', () => {
    expect(service.recordSpan('no-such-trace', { kind: 'act', name: 'x' })).toBeNull();

    const spans = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_trace_spans`);
    expect(spans?.n ?? -1).toBe(0);
  });

  it('空 traceId：recordSpan 返回 null', () => {
    expect(service.recordSpan('', { kind: 'act', name: 'x' })).toBeNull();
  });

  it('非法 kind：recordSpan 返回 null，且 span_count 不变', () => {
    const trace = service.startTrace('sess-6', 'bad-kind')!;
    const span = service.recordSpan(trace.traceId, {
      kind: 'nonsense' as TraceSpanKind,
      name: 'x',
    });

    expect(span).toBeNull();
    expect(spanCountOf(trace.traceId)).toBe(0);
    expect(spanRowsOf(trace.traceId)).toBe(0);
  });

  it('endTrace 对不存在的 traceId 不抛错', () => {
    expect(() => service.endTrace('no-such-trace', 'ok')).not.toThrow();
  });

  it('endTrace 先到先得：已定局的轨迹不被后来的调用改判', () => {
    const trace = service.startTrace('sess-7', 'final')!;
    service.endTrace(trace.traceId, 'ok');
    service.endTrace(trace.traceId, 'error');

    expect(service.list()[0]?.status).toBe('ok');
  });

  it('endTrace 写的是正确的 endedAt（不早于 startedAt）', () => {
    vi.useFakeTimers();
    const base = Date.parse('2024-01-01T00:00:00.000Z');
    vi.setSystemTime(base);
    const trace = service.startTrace('sess-8', 'timed')!;
    vi.setSystemTime(base + 5_000);
    service.endTrace(trace.traceId, 'ok');

    const summary = service.list()[0];
    expect(summary?.endedAt).toBe(base + 5_000);
    expect(summary?.endedAt).toBeGreaterThanOrEqual(summary?.startedAt ?? 0);
  });
});

describe('TracesController 响应契约', () => {
  function call(query: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
    const controller = new TracesController(service);
    let payload: Record<string, unknown> = {};
    const res = {
      json(body: Record<string, unknown>) {
        payload = body;
        return res;
      },
    };
    const req = { query };
    controller.list(req as never, res as never);
    return { status: 200, body: payload };
  }

  it('列表响应：{ enabled: true, traces: [...] }', () => {
    const trace = service.startTrace('sess-9', 'loop')!;
    service.recordSpan(trace.traceId, { kind: 'act', name: 'fs.read' });

    const { body } = call({ limit: '50' });
    expect(body.enabled).toBe(true);
    expect(Array.isArray(body.traces)).toBe(true);
    expect(body.traces).toHaveLength(1);
    expect((body.traces as Array<{ spanCount: number }>)[0]?.spanCount).toBe(1);
  });

  it('明细响应：{ enabled: true, traceId, spans: [...] }', () => {
    const trace = service.startTrace('sess-9', 'loop')!;
    service.recordSpan(trace.traceId, { kind: 'judge', name: 'judge.runs' });

    const { body } = call({ traceId: trace.traceId });
    expect(body.enabled).toBe(true);
    expect(body.traceId).toBe(trace.traceId);
    expect(body.spans).toHaveLength(1);
    expect((body.spans as Array<{ kind: string }>)[0]?.kind).toBe('judge');
  });

  it('未启用：{ enabled: false, traces: [] }', () => {
    const off = new TracesController(new TraceService({ db, enabled: false }));
    let payload: Record<string, unknown> = {};
    const res = {
      json(body: Record<string, unknown>) {
        payload = body;
        return res;
      },
    };
    off.list({ query: {} } as never, res as never);

    expect(payload.enabled).toBe(false);
    expect(payload.traces).toEqual([]);
  });

  it('非法 limit 由 service 收敛，controller 不自己判断', () => {
    for (let i = 0; i < 55; i += 1) service.startTrace('sess-limit', `t${i}`);

    expect((call({ limit: '0' }).body.traces as unknown[]).length).toBe(50);
    expect((call({ limit: '-3' }).body.traces as unknown[]).length).toBe(50);
    expect((call({ limit: 'abc' }).body.traces as unknown[]).length).toBe(50);
    expect((call({ limit: '9999' }).body.traces as unknown[]).length).toBe(55);
  });
});
