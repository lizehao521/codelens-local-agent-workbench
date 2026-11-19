// src/services/rsi/cross-generation-oscillation.test.ts
import { describe, it, expect } from 'vitest';
import {
  detectOscillation,
  decideRollback,
  DEFAULT_WINDOW,
  type OscillationInput,
  type RollbackInput,
  type SnapshotCandidate,
} from './cross-generation-oscillation.js';
import type {
  GenerationIndicators,
  IndicatorValue,
} from './cross-generation-verdict.js';
import type { MetricDefinition } from './cross-generation-contract.js';

// ========== 测试夹具 ==========

const primaryMetric: MetricDefinition = {
  id: 'test_pass_rate',
  definitionVersion: '1.0.0',
  direction: 'higher_is_better',
  unit: 'ratio',
};

const guardMetric: MetricDefinition = {
  id: 'tool_success_rate',
  definitionVersion: '1.0.0',
  direction: 'higher_is_better',
  unit: 'ratio',
};

function createIndicatorValue(
  definition: MetricDefinition,
  value: number,
): IndicatorValue {
  return { definition, value };
}

function createSnapshot(
  generation: number,
  primaryValue: number,
  guardValue: number,
  evidenceLevel: 'full_suite_passed' | 'partial' | 'none',
  timestamp: number,
): SnapshotCandidate {
  return {
    generation,
    indicators: {
      primary: createIndicatorValue(primaryMetric, primaryValue),
      guards: [createIndicatorValue(guardMetric, guardValue)],
    },
    evidenceLevel,
    timestamp,
  };
}

// ========== 震荡判据测试 ==========

describe('detectOscillation', () => {
  it('0.60/0.65 往返无净改善 → oscillating', () => {
    const input: OscillationInput = {
      // 修正：首末同值（0.60），真正"无净改善"
      primaryValues: [0.60, 0.66, 0.61, 0.67, 0.60, 0.60],
      primaryDirection: 'higher_is_better',
    };

    const result = detectOscillation(input);

    expect(result.verdict).toBe('oscillating');
    expect(result.crossings).toBeGreaterThanOrEqual(2);
    expect(result.netImprovement).toBeLessThanOrEqual(0);
    expect(result.samples).toBe(6);
  });

  it('净改善序列 → not_oscillating', () => {
    const input: OscillationInput = {
      primaryValues: [0.60, 0.62, 0.64, 0.66, 0.68],
      primaryDirection: 'higher_is_better',
    };

    const result = detectOscillation(input);

    expect(result.verdict).toBe('not_oscillating');
    expect(result.netImprovement).toBeGreaterThan(0);
  });

  it('单次下降 → not_oscillating', () => {
    const input: OscillationInput = {
      primaryValues: [0.68, 0.60],
      primaryDirection: 'higher_is_better',
    };

    const result = detectOscillation(input);

    expect(result.verdict).toBe('undecidable'); // 样本不足（< 4）
    expect(result.reason).toContain('样本不足');
  });

  it('样本不足 → undecidable', () => {
    const input: OscillationInput = {
      primaryValues: [0.60, 0.66],
      primaryDirection: 'higher_is_better',
    };

    const result = detectOscillation(input);

    expect(result.verdict).toBe('undecidable');
    expect(result.reason).toContain('样本不足');
    expect(result.samples).toBe(2);
  });

  it('滞回带内抖动 → not_oscillating', () => {
    const input: OscillationInput = {
      primaryValues: [0.64, 0.65, 0.66, 0.65, 0.64, 0.65],
      primaryDirection: 'higher_is_better',
    };

    const result = detectOscillation(input);

    // 滞回带 0.02，阈值 0.65，范围 [0.63, 0.67]
    // 所有值都在滞回带内，不应判为有效跨越
    expect(result.verdict).toBe('not_oscillating');
    expect(result.crossings).toBe(0);
  });

  it('lower_is_better 方向正确', () => {
    const input: OscillationInput = {
      // 修正：首末同值（0.70），真正"无净改善"
      primaryValues: [0.70, 0.64, 0.69, 0.63, 0.70, 0.70],
      primaryDirection: 'lower_is_better',
    };

    const result = detectOscillation(input);

    expect(result.verdict).toBe('oscillating');
    expect(result.netImprovement).toBeLessThanOrEqual(0);
  });
});

// ========== 回滚判据测试 ==========

describe('decideRollback', () => {
  it('主目标未改善 + guard 恶化 → rollback', () => {
    const snapshots: SnapshotCandidate[] = [
      createSnapshot(1, 0.60, 0.85, 'full_suite_passed', 1000),
      createSnapshot(2, 0.62, 0.88, 'full_suite_passed', 2000),
      createSnapshot(3, 0.64, 0.90, 'full_suite_passed', 3000),
    ];

    const input: RollbackInput = {
      currentPrimary: createIndicatorValue(primaryMetric, 0.63),
      previousPrimary: createIndicatorValue(primaryMetric, 0.64),
      currentGuards: [createIndicatorValue(guardMetric, 0.80)],
      previousGuards: [createIndicatorValue(guardMetric, 0.90)],
      snapshots,
    };

    const result = decideRollback(input);

    expect(result.action).toBe('rollback');
    expect(result.targetSnapshot).toBeDefined();
    expect(result.targetSnapshot?.generation).toBe(3);
    expect(result.targetSnapshot?.evidenceLevel).toBe('full_suite_passed');
  });

  it('主目标已改善 → no_rollback', () => {
    const snapshots: SnapshotCandidate[] = [
      createSnapshot(1, 0.60, 0.85, 'full_suite_passed', 1000),
    ];

    const input: RollbackInput = {
      currentPrimary: createIndicatorValue(primaryMetric, 0.66),
      previousPrimary: createIndicatorValue(primaryMetric, 0.64),
      currentGuards: [createIndicatorValue(guardMetric, 0.80)],
      previousGuards: [createIndicatorValue(guardMetric, 0.90)],
      snapshots,
    };

    const result = decideRollback(input);

    expect(result.action).toBe('no_rollback');
    expect(result.reason).toContain('主目标已改善');
  });

  it('主目标未改善但 guard 未恶化 → no_rollback', () => {
    const snapshots: SnapshotCandidate[] = [
      createSnapshot(1, 0.60, 0.85, 'full_suite_passed', 1000),
    ];

    const input: RollbackInput = {
      currentPrimary: createIndicatorValue(primaryMetric, 0.63),
      previousPrimary: createIndicatorValue(primaryMetric, 0.64),
      currentGuards: [createIndicatorValue(guardMetric, 0.90)],
      previousGuards: [createIndicatorValue(guardMetric, 0.90)],
      snapshots,
    };

    const result = decideRollback(input);

    expect(result.action).toBe('no_rollback');
    expect(result.reason).toContain('guard 未恶化');
  });

  it('快照不可恢复 → undecidable', () => {
    const snapshots: SnapshotCandidate[] = [
      createSnapshot(1, 0.60, 0.85, 'partial', 1000),
      createSnapshot(2, 0.62, 0.88, 'none', 2000),
    ];

    const input: RollbackInput = {
      currentPrimary: createIndicatorValue(primaryMetric, 0.63),
      previousPrimary: createIndicatorValue(primaryMetric, 0.64),
      currentGuards: [createIndicatorValue(guardMetric, 0.80)],
      previousGuards: [createIndicatorValue(guardMetric, 0.90)],
      snapshots,
    };

    const result = decideRollback(input);

    expect(result.action).toBe('undecidable');
    expect(result.reason).toContain('快照不可恢复');
    expect(result.targetSnapshot).toBeUndefined();
  });

  it('选择最近已验证快照（跳过未验证）', () => {
    const snapshots: SnapshotCandidate[] = [
      createSnapshot(1, 0.60, 0.85, 'full_suite_passed', 1000),
      createSnapshot(2, 0.62, 0.88, 'full_suite_passed', 2000),
      createSnapshot(3, 0.64, 0.90, 'partial', 3000), // 未验证
    ];

    const input: RollbackInput = {
      currentPrimary: createIndicatorValue(primaryMetric, 0.63),
      previousPrimary: createIndicatorValue(primaryMetric, 0.64),
      currentGuards: [createIndicatorValue(guardMetric, 0.80)],
      previousGuards: [createIndicatorValue(guardMetric, 0.90)],
      snapshots,
    };

    const result = decideRollback(input);

    expect(result.action).toBe('rollback');
    expect(result.targetSnapshot?.generation).toBe(2); // 跳过第 3 代
  });
});
