/**
 * 强化「可验证性」维度：为 P1 只读消费解析器 parseShadowVerdict 提供 12 个守门用例，
 * 覆盖 absent/ok/error/坏 JSON/字段错位/多 span 取最新，确保跨代判决可被机械消费且异常安全。
 */
import { describe, it, expect } from 'vitest';
import type { TraceSpan } from './trace.service.js';
import { parseShadowVerdict, SHADOW_VERDICT_SPAN_NAME } from './shadow-verdict.parser.js';

function span(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    spanId: 's1',
    traceId: 't1',
    seq: 1,
    kind: 'judge',
    name: SHADOW_VERDICT_SPAN_NAME,
    status: 'ok',
    detail: JSON.stringify({
      state: 'improved',
      verdict: 'improved',
      source: 'cross_generation',
      reason: 'all metrics improved',
      hadPrevious: true,
    }),
    durationMs: 0,
    createdAt: 1000,
    ...overrides,
  };
}

describe('parseShadowVerdict —— 跨代影子判决只读消费', () => {
  it('1. 无 span → absent', () => {
    expect(parseShadowVerdict([])).toEqual({ outcome: 'absent' });
  });

  it('2. 有 span 但无匹配 name → absent', () => {
    expect(parseShadowVerdict([span({ name: 'other' })])).toEqual({ outcome: 'absent' });
  });

  it('3. 单条 ok span，5 键完整 → ok，字段值正确', () => {
    const v = parseShadowVerdict([span()]);
    expect(v.outcome).toBe('ok');
    if (v.outcome === 'ok') {
      expect(v.state).toBe('improved');
      expect(v.verdict).toBe('improved');
      expect(v.source).toBe('cross_generation');
      expect(v.reason).toBe('all metrics improved');
      expect(v.hadPrevious).toBe(true);
      expect(v.spanId).toBe('s1');
      expect(v.traceId).toBe('t1');
      expect(v.createdAt).toBe(1000);
    }
  });

  it('4. 单条 error span → failed，error 含原始 detail', () => {
    const v = parseShadowVerdict([span({ status: 'error', detail: 'shadow failed: timeout' })]);
    expect(v.outcome).toBe('failed');
    if (v.outcome === 'failed') expect(v.error).toContain('shadow failed: timeout');
  });

  it('5. ok 但 detail 为 undefined → failed（detail is empty）', () => {
    const v = parseShadowVerdict([span({ detail: undefined })]);
    expect(v.outcome).toBe('failed');
    if (v.outcome === 'failed') expect(v.error).toContain('detail is empty');
  });

  it('6. ok 但 detail 是非法 JSON → failed（JSON.parse failed）', () => {
    const v = parseShadowVerdict([span({ detail: '{broken' })]);
    expect(v.outcome).toBe('failed');
    if (v.outcome === 'failed') expect(v.error).toContain('JSON.parse failed');
  });

  it('7. ok 但 detail 解析为数组 → failed（not a plain object）', () => {
    const v = parseShadowVerdict([span({ detail: '[1,2]' })]);
    expect(v.outcome).toBe('failed');
    if (v.outcome === 'failed') expect(v.error).toContain('not a plain object');
  });

  it('8. ok 但缺少 required key → failed（missing required key）', () => {
    const v = parseShadowVerdict([span({ detail: '{"state":"s","verdict":"v"}' })]);
    expect(v.outcome).toBe('failed');
    if (v.outcome === 'failed') expect(v.error).toContain('missing required key');
  });

  it('9. hadPrevious 类型错误 → failed（expected boolean）', () => {
    const v = parseShadowVerdict([
      span({
        detail: JSON.stringify({
          state: 'improved', verdict: 'improved', source: 'cross_generation',
          reason: 'x', hadPrevious: 'yes',
        }),
      }),
    ]);
    expect(v.outcome).toBe('failed');
    if (v.outcome === 'failed') expect(v.error).toContain('expected boolean');
  });

  it('10. 多条匹配 span，取 seq 最大（最新）', () => {
    const old = span({
      seq: 3,
      spanId: 'old',
      detail: JSON.stringify({
        state: 'not_improved', verdict: 'not_improved', source: 'cross_generation',
        reason: 'old', hadPrevious: true,
      }),
    });
    const fresh = span({
      seq: 7,
      spanId: 'fresh',
      detail: JSON.stringify({
        state: 'improved', verdict: 'improved', source: 'cross_generation',
        reason: 'fresh', hadPrevious: true,
      }),
    });
    const v = parseShadowVerdict([old, fresh]);
    expect(v.outcome).toBe('ok');
    if (v.outcome === 'ok') {
      expect(v.verdict).toBe('improved');
      expect(v.spanId).toBe('fresh');
    }
  });

  it('11. 多条匹配，最新是 error → failed', () => {
    const ok = span({ seq: 3 });
    const err = span({ seq: 7, status: 'error', detail: 'shadow failed: boom' });
    const v = parseShadowVerdict([ok, err]);
    expect(v.outcome).toBe('failed');
    if (v.outcome === 'failed') expect(v.error).toContain('boom');
  });

  it('12. ok 但 detail 解析为 null → failed（not a plain object）', () => {
    const v = parseShadowVerdict([span({ detail: 'null' })]);
    expect(v.outcome).toBe('failed');
    if (v.outcome === 'failed') expect(v.error).toContain('not a plain object');
  });

  // ── P3：pg/cg 可选键（依据哪两代） ──
  it('13. 含 pg/cg → ok，两值正确透出', () => {
    const v = parseShadowVerdict([
      span({
        detail: JSON.stringify({
          state: 'improved', verdict: 'improved', source: 'cross_generation',
          reason: 'x', hadPrevious: true, pg: 1, cg: 2,
        }),
      }),
    ]);
    expect(v.outcome).toBe('ok');
    if (v.outcome === 'ok') {
      expect(v.pg).toBe(1);
      expect(v.cg).toBe(2);
    }
  });

  it('14. 无 pg/cg（历史 span）→ ok 且两值为 undefined（向后兼容）', () => {
    const v = parseShadowVerdict([span()]);
    expect(v.outcome).toBe('ok');
    if (v.outcome === 'ok') {
      expect(v.pg).toBeUndefined();
      expect(v.cg).toBeUndefined();
    }
  });

  it('15. pg=null（第一代）→ ok，pg 为 null', () => {
    const v = parseShadowVerdict([
      span({
        detail: JSON.stringify({
          state: 'improved', verdict: 'improved', source: 'cross_generation',
          reason: 'x', hadPrevious: false, pg: null, cg: 1,
        }),
      }),
    ]);
    expect(v.outcome).toBe('ok');
    if (v.outcome === 'ok') {
      expect(v.pg).toBeNull();
      expect(v.cg).toBe(1);
    }
  });

  it('16. cg=null（空表）→ ok，cg 为 null', () => {
    const v = parseShadowVerdict([
      span({
        detail: JSON.stringify({
          state: 'skipped', verdict: 'undecidable', source: 'cross_generation',
          reason: 'no previous', hadPrevious: false, pg: null, cg: null,
        }),
      }),
    ]);
    expect(v.outcome).toBe('ok');
    if (v.outcome === 'ok') {
      expect(v.pg).toBeNull();
      expect(v.cg).toBeNull();
    }
  });

  it('17. pg 类型错（字符串）→ failed（must be number or null）', () => {
    const v = parseShadowVerdict([
      span({
        detail: JSON.stringify({
          state: 'improved', verdict: 'improved', source: 'cross_generation',
          reason: 'x', hadPrevious: true, pg: '1', cg: 2,
        }),
      }),
    ]);
    expect(v.outcome).toBe('failed');
    if (v.outcome === 'failed') expect(v.error).toContain('pg must be number or null');
  });

  it('18. cg 类型错（布尔）→ failed（must be number or null）', () => {
    const v = parseShadowVerdict([
      span({
        detail: JSON.stringify({
          state: 'improved', verdict: 'improved', source: 'cross_generation',
          reason: 'x', hadPrevious: true, pg: 1, cg: true,
        }),
      }),
    ]);
    expect(v.outcome).toBe('failed');
    if (v.outcome === 'failed') expect(v.error).toContain('cg must be number or null');
  });

  // B 项：consistencyShadow 可选键（对象浅校验透传，不污染 7 键）。
  it('19. 无 consistencyShadow（历史 7 键 span）→ ok，视图无此键', () => {
    const v = parseShadowVerdict([
      span({
        detail: JSON.stringify({
          state: 'improved', verdict: 'improved', source: 'cross_generation',
          reason: 'x', hadPrevious: true, pg: 1, cg: 2,
        }),
      }),
    ]);
    expect(v.outcome).toBe('ok');
    expect(v).not.toHaveProperty('consistencyShadow');
  });

  it('20. consistencyShadow 为对象 → ok，原样透传', () => {
    const cs = { status: 'partial', violations: [], unavailableChecks: [{ inv: 'INV-1' }] };
    const v = parseShadowVerdict([
      span({
        detail: JSON.stringify({
          state: 'improved', verdict: 'improved', source: 'cross_generation',
          reason: 'x', hadPrevious: true, pg: 1, cg: 2, consistencyShadow: cs,
        }),
      }),
    ]);
    expect(v.outcome).toBe('ok');
    if (v.outcome === 'ok') expect(v.consistencyShadow).toEqual(cs);
  });

  it('21. consistencyShadow 为数组/字符串/数字 → 不透传，7 键仍 ok', () => {
    for (const bad of [[], 'x', 42]) {
      const v = parseShadowVerdict([
        span({
          detail: JSON.stringify({
            state: 'improved', verdict: 'improved', source: 'cross_generation',
            reason: 'x', hadPrevious: true, consistencyShadow: bad,
          }),
        }),
      ]);
      expect(v.outcome).toBe('ok');
      expect(v).not.toHaveProperty('consistencyShadow');
    }
  });
});
