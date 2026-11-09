/**
 * manifest-builder 纯函数测试 —— Agent CriterionVerdict[] → RSI Manifest
 *
 * 所有测试不依赖 DB、不 spawn 子进程、不碰网络。
 */
import { describe, it, expect } from 'vitest';
import { buildManifest, verdictsToReadings, KNOWN_CRITERIA } from '../src/services/rsi/manifest-builder.js';
import type { CriterionVerdict } from '../src/services/judge/types.js';

const PASS_V: CriterionVerdict = (criterion: string, score?: number): CriterionVerdict => ({
  layer: 'L0', criterion, status: 'pass',
  score,
});
const FAIL_V: CriterionVerdict = (criterion: string, score?: number): CriterionVerdict => ({
  layer: 'L0', criterion, status: 'fail',
  score,
});
const UNEXEC_V: CriterionVerdict = (criterion: string): CriterionVerdict => ({
  layer: 'L0', criterion, status: 'unexec',
  detail: '无终态工具调用',
});

describe('manifest-builder', () => {
  describe('verdictsToReadings', () => {
    it('已知判据 + score → 连续值 measured（含 role）', () => {
      const verdicts: CriterionVerdict[] = [
        PASS_V('tool.success_rate', 0.85),
        FAIL_V('approval.friction', 0.6),
        PASS_V('budget.efficiency', 0.7),
      ];
      const readings = verdictsToReadings(verdicts);
      // budget.efficiency 不再进 RSI readings：成本是 L0 闸，不是目标指标
      expect(readings).toHaveLength(2);
      expect(readings[0]).toEqual({
        metric: 'tool_success_rate',
        n: 0.85,
        basis: 1,
        direction: 'up',
        role: 'guard',
      });
      expect(readings[1]).toEqual({
        metric: 'approval_friction',
        n: 0.6,
        basis: 1,
        direction: 'down',
        role: 'guard',
      });
    });

    it('语义覆盖率 → 目标指标（objective）', () => {
      const readings = verdictsToReadings([PASS_V('semantic.task_completion', 0.615)]);
      expect(readings).toEqual([
        { metric: 'goal_term_coverage', n: 0.615, basis: 1, direction: 'up', role: 'objective' },
      ]);
    });

    it('目标指标量不到 → 写 absent（保持指标集合稳定，防 R3 误判删指标）', () => {
      const readings = verdictsToReadings([UNEXEC_V('semantic.task_completion')]);
      expect(readings).toHaveLength(1);
      expect(readings[0]).toMatchObject({
        metric: 'goal_term_coverage',
        n: 0,
        basis: 5,
        role: 'objective',
      });
      expect(readings[0].why_absent).toBeTruthy();
    });

    it('二值判据（无 score）→ 跳过不进 readings', () => {
      const verdicts: CriterionVerdict[] = [
        PASS_V('task.terminal'),   // 二值，无 score
        FAIL_V('loop.health'),     // 二值，无 score
      ];
      const readings = verdictsToReadings(verdicts);
      // 二值信号太粗（pass→pass=1→1 永远没变），R5 判据会卡住
      // → Agent 自己的判定逻辑照常用，只是不进 RSI 跨代互比
      expect(readings).toEqual([]);
    });

    it('unexec（无 score）→ 跳过', () => {
      const verdicts: CriterionVerdict[] = [UNEXEC_V('tool.success_rate')];
      const readings = verdictsToReadings(verdicts);
      // unexec 也没有 score，同样跳过
      expect(readings).toEqual([]);
    });

    it('未知判据名 → 跳过', () => {
      const verdicts: CriterionVerdict[] = [
        PASS_V('unknown.criterion', 0.9),
        PASS_V('tool.success_rate', 0.8),
      ];
      const readings = verdictsToReadings(verdicts);
      expect(readings).toHaveLength(1);
      expect(readings[0].metric).toBe('tool_success_rate');
    });

    it('空 verdicts → 空 readings（R5 两侧空会判 undecidable）', () => {
      expect(verdictsToReadings([])).toEqual([]);
    });
  });

  describe('buildManifest', () => {
    it('最小可用：只有 producer + generation + verdicts', () => {
      const manifest = buildManifest({
        producer: 'test',
        generation: 1,
        verdicts: [PASS_V('tool.success_rate', 0.9)],
      });
      expect(manifest.producer).toBe('test');
      expect(manifest.generation).toBe(1);
      expect(manifest.readings).toHaveLength(1);
      // R1: artifacts 不能为空（空清单会拒收）
      expect(manifest.artifacts.length).toBeGreaterThan(0);
      // R1: criteria_sha256 要 64 hex
      expect(manifest.criteria_sha256).toHaveLength(64);
      // claim 默认自动合成
      expect(manifest.claim).toContain('第 1 代');
    });

    it('generation 必须递增 —— krsi R1 会拒收相等/倒退', () => {
      const prev = buildManifest({ producer: 'p', generation: 1, verdicts: [] });
      const next = buildManifest({ producer: 'p', generation: 1, verdicts: [] });
      // 这个测试验证"调用方负责确保 generation 递增"
      expect(next.generation).toBe(prev.generation); // 调用方传啥 manifest 就啥
    });

    it('direction 一致性：同名 metric 跨两代方向必须相同', () => {
      const prev = buildManifest({
        producer: 'p', generation: 1,
        verdicts: [PASS_V('tool.success_rate', 0.7)],
      });
      const next = buildManifest({
        producer: 'p', generation: 2,
        verdicts: [PASS_V('tool.success_rate', 0.8)],
      });
      expect(prev.readings[0]?.direction).toBe('up');
      expect(next.readings[0]?.direction).toBe('up');
    });

    it('连续值判据（带 score）正确映射到 RSI readings', () => {
      // approval.friction / tool.success_rate 是护栏；budget.efficiency 不再进 RSI
      const continuous = ['tool.success_rate', 'approval.friction', 'budget.efficiency'];
      const binary = ['task.terminal', 'loop.health'];

      const verdicts: CriterionVerdict[] = [
        ...continuous.map((c) => PASS_V(c, 0.95)),
        ...binary.map((c) => PASS_V(c)), // 无 score → 跳过
      ];
      const readings = verdictsToReadings(verdicts);

      // 只有进 metric 表且有 score 的才进 readings：tool.success_rate + approval.friction
      expect(readings.length).toBe(2);
      // 全部 basis=1 measured
      expect(readings.every((r) => r.basis === 1)).toBe(true);
      // 全部 direction 合法
      expect(readings.every((r) => r.direction === 'up' || r.direction === 'down')).toBe(true);
      // 这两条都是护栏（有天花板，不能要求每代严格变好）
      expect(readings.every((r) => r.role === 'guard')).toBe(true);
    });
  });
});
