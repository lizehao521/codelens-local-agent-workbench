/**
 * cross-generation-bridge：影子评估单元测试。
 * 基于保守证据映射（所有 state → landed + landedFilesHash=ledgerPath），
 * 验证 evaluateCrossGenerationVerdict 不会再抛 INVALID_EVIDENCE，
 * 且四值 verdict 映射、previous=null 短路、next.state 不可变、序列化往返均正确。
 * 无 skip / only；不使用 JSON.parse(serializedVerdict)。
 */
import { describe, it, expect } from 'vitest';
import { evaluateCrossGenerationShadow } from './cross-generation-bridge.js';
import { makeResult } from './cross-generation-bridge.fixture.js';

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
