/**
 * cross-generation-bridge：跨代影子判决审计行为对齐测试。
 * 保证下推到 bridge 的影子判决与 agent-loop 内联版行为一致：只记轨迹、不改 result、不写库、不抛错。
 */
import { describe, it, expect, vi } from 'vitest';
import { recordShadowAudit } from './cross-generation-bridge.js';
import { makeResult } from './cross-generation-bridge.fixture.js';


/**
 * recordShadowAudit（P0 接线收敛辅助）行为对齐测试。
 * 保证下推到 bridge 的影子判决与 agent-loop 内联版行为一致：只记轨迹、不改 result、不写库、不抛错。
 */
describe('recordShadowAudit', () => {
  type Span = { kind: string; name: string; status?: string; detail?: string; durationMs?: number };
  function setup(opts: { rows?: Array<{ generation: number; prev_generation?: number | null; verdict: string }>; throwOnGet?: boolean } = {}) {
    const spans: Array<{ traceId: string | null | undefined; span: Span }> = [];
    const recordSpan = vi.fn((traceId: string | null | undefined, span: Span) => spans.push({ traceId, span }));
    const db = {
      get<T>(sql: string, params?: Array<string | number | null>): T | undefined {
        if (opts.throwOnGet) throw new Error('db down');
        // 模拟「取最新行的 generation 与其 prev_generation」查询（recordShadowAudit 的取数）
        if (sql.includes('prev_generation AS pg')) {
          const latest = (opts.rows ?? []).slice().sort((a, b) => b.generation - a.generation)[0];
          if (!latest) return undefined;
          return { cg: latest.generation, pg: latest.prev_generation ?? null } as unknown as T;
        }
        // 模拟 loadPreviousGeneration 的 SELECT：generation < curGen 取最新
        if (sql.includes('generation <')) {
          const cur = params?.[1] as number;
          const picked = (opts.rows ?? [])
            .filter((r) => r.generation < cur)
            .sort((a, b) => b.generation - a.generation)[0];
          if (!picked) return undefined;
          return {
            verdict: picked.verdict, exit_code: 0, reasons_json: null,
            metrics_json: null, ledger_path: `/tmp/gen${picked.generation}.jsonl`,
          } as unknown as T;
        }
        return undefined;
      },
    };
    return { db, recordSpan, spans };
  }
  const next = makeResult({ state: 'improved' });

  it('有上一代 → recordSpan ok，detail 为合法 JSON 且含 verdict/hadPrevious', () => {
    const { db, recordSpan, spans } = setup({ rows: [{ generation: 1, verdict: 'not_improved' }, { generation: 2, verdict: 'improved' }] });
    recordShadowAudit({ db, sessionId: 's1', result: next, traceId: 't1', recordSpan });
    expect(recordSpan).toHaveBeenCalledTimes(1);
    const span = spans[0]!.span;
    expect(span.kind).toBe('judge');
    expect(span.name).toBe('跨代影子判决');
    expect(span.status).toBe('ok');
    const detail = JSON.parse(span.detail!) as { verdict: string; hadPrevious: boolean };
    expect(typeof detail.verdict).toBe('string');
    expect(detail.hadPrevious).toBe(true);
  });

  it('无上一代（库内仅当前代）→ hadPrevious=false，仍 status=ok', () => {
    const { db, recordSpan, spans } = setup({ rows: [{ generation: 1, verdict: 'improved' }] });
    recordShadowAudit({ db, sessionId: 's1', result: next, traceId: 't1', recordSpan });
    const detail = JSON.parse(spans[0]!.span.detail!) as { hadPrevious: boolean };
    expect(detail.hadPrevious).toBe(false);
    expect(spans[0]!.span.status).toBe('ok');
  });

  it('不改 result（state/reasons/metrics 引用与值不变）', () => {
    const { db, recordSpan } = setup({ rows: [{ generation: 1, verdict: 'not_improved' }] });
    const before = { state: next.state, reasons: next.reasons, metrics: next.metrics };
    recordShadowAudit({ db, sessionId: 's1', result: next, traceId: 't1', recordSpan });
    expect(next.state).toBe(before.state);
    expect(next.reasons).toBe(before.reasons);
    expect(next.metrics).toBe(before.metrics);
  });

  it('db 抛错 → 异常被吞，recordSpan status=error，不向外抛', () => {
    const { db, recordSpan, spans } = setup({ throwOnGet: true });
    expect(() => recordShadowAudit({ db, sessionId: 's1', result: next, traceId: 't1', recordSpan })).not.toThrow();
    expect(spans[0]!.span.status).toBe('error');
    expect(spans[0]!.span.detail).toContain('shadow failed');
  });

  it('db 为 undefined → 不抛，仍记一条 error span（异常隔离）', () => {
    const recordSpan = vi.fn((_t: string | null | undefined, _s: Span) => {});
    expect(() => recordShadowAudit({ db: undefined, sessionId: 's1', result: next, traceId: 't1', recordSpan })).not.toThrow();
  });

  // P3：detail 增加 pg/cg 两键（依据哪两代），CG 取当前代、PG 取该代 prev_generation 列。
  it('跨代（gen=1←null，gen=2←1）→ detail 含 cg=2, pg=1', () => {
    const { db, recordSpan, spans } = setup({
      rows: [
        { generation: 1, prev_generation: null, verdict: 'not_improved' },
        { generation: 2, prev_generation: 1, verdict: 'improved' },
      ],
    });
    recordShadowAudit({ db, sessionId: 's1', result: next, traceId: 't1', recordSpan });
    const detail = JSON.parse(spans[0]!.span.detail!) as { cg: number | null; pg: number | null; hadPrevious: boolean };
    expect(detail.cg).toBe(2);
    expect(detail.pg).toBe(1);
    expect(detail.hadPrevious).toBe(true);
  });

  it('第一代（gen=1，prev_generation=null）→ detail 含 cg=1, pg=null', () => {
    const { db, recordSpan, spans } = setup({ rows: [{ generation: 1, prev_generation: null, verdict: 'improved' }] });
    recordShadowAudit({ db, sessionId: 's1', result: next, traceId: 't1', recordSpan });
    const detail = JSON.parse(spans[0]!.span.detail!) as { cg: number | null; pg: number | null };
    expect(detail.cg).toBe(1);
    expect(detail.pg).toBeNull();
  });

  it('空表 → detail 含 cg=null, pg=null（不伪报第 0 代）', () => {
    const { db, recordSpan, spans } = setup({ rows: [] });
    recordShadowAudit({ db, sessionId: 's1', result: next, traceId: 't1', recordSpan });
    const detail = JSON.parse(spans[0]!.span.detail!) as { cg: number | null; pg: number | null; hadPrevious: boolean };
    expect(detail.cg).toBeNull();
    expect(detail.pg).toBeNull();
    expect(detail.hadPrevious).toBe(false);
  });

  // B 项：一致性阴影视图（codelens exp167 裁定，只审计不驱动 rollback）。
  it('B：db.all 提供多代行 → detail 含 consistencyShadow（无 consistent 布尔、两条不可用判据）', () => {
    const { db, recordSpan, spans } = setup({
      rows: [
        { generation: 1, prev_generation: null, verdict: 'not_improved' },
        { generation: 2, prev_generation: 1, verdict: 'improved' },
      ],
    });
    const dbWithAll = {
      ...db,
      all<T>(sql: string): T[] {
        if (sql.includes('ledger_path')) {
          return [
            { generation: 1, ledger_path: 'same' },
            { generation: 2, ledger_path: 'same' },
          ] as unknown as T[];
        }
        return [];
      },
    };
    recordShadowAudit({ db: dbWithAll, sessionId: 's1', result: next, traceId: 't1', recordSpan });
    const detail = JSON.parse(spans[0]!.span.detail!) as {
      consistencyShadow?: { status: string; violations: unknown[]; unavailableChecks: unknown[]; consistent?: boolean };
    };
    expect(spans[0]!.span.status).toBe('ok');
    expect(detail.consistencyShadow).toBeDefined();
    expect(detail.consistencyShadow!.status).toBe('partial');
    expect(detail.consistencyShadow!.consistent).toBeUndefined();
    expect(detail.consistencyShadow!.unavailableChecks).toHaveLength(2);
  });

  it('B：db.all 缺失 → consistencyShadow 降级为空视图，不抛错、影子判决仍 ok', () => {
    const { db, recordSpan, spans } = setup({ rows: [{ generation: 1, verdict: 'improved' }] });
    recordShadowAudit({ db, sessionId: 's1', result: next, traceId: 't1', recordSpan });
    expect(spans[0]!.span.status).toBe('ok');
    const detail = JSON.parse(spans[0]!.span.detail!) as { consistencyShadow?: { status: string } };
    expect(detail.consistencyShadow?.status).toBe('partial');
  });

  it('B：detail 恒为合法 JSON 且不超 DETAIL_MAX=500（含 consistencyShadow 时）', () => {
    const { db, recordSpan, spans } = setup({
      rows: [
        { generation: 1, prev_generation: null, verdict: 'not_improved' },
        { generation: 2, prev_generation: 1, verdict: 'improved' },
      ],
    });
    recordShadowAudit({ db, sessionId: 's1', result: next, traceId: 't1', recordSpan });
    expect(spans[0]!.span.status).toBe('ok');
    const raw = spans[0]!.span.detail!;
    expect(raw.length).toBeLessThanOrEqual(500);
    const detail = JSON.parse(raw) as {
      state: string; hadPrevious: boolean; pg: unknown; cg: unknown;
      consistencyShadow?: { status: string };
    };
    expect(detail).toHaveProperty('state');
    expect(detail).toHaveProperty('hadPrevious');
    expect(detail).toHaveProperty('cg');
    // 本 fixture reason 短，consistencyShadow 应保留；超长时降级分支由实现保证 7 键完整。
    expect(detail.consistencyShadow?.status).toBe('partial');
  });
});

