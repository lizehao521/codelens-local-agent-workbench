import { describe, expect, it } from 'vitest';
import { ConvergenceDetector, type RoundSignature } from '../src/services/agent/convergence-detector.js';

/**
 * M1 判据：threshold=1 不得首轮即判收敛。
 * 配置注释明确「1 轮可能是模型在确认，2 轮仍可能重试；3 轮同签名基本可判空转」
 * —— 阈值 1 与收敛语义冲突。红队 TASK-002 finding[2]（medium）。
 *
 * 修复方向由 A 自定，但必须满足：
 *   - threshold=1 首轮无变化不得 converged
 *   - threshold=0 仍为关闭（不破坏 0=关闭语义）
 *   - threshold=3 既有行为不变（首轮 streak=1，第 3 轮收敛）
 */
describe('收敛判定 M1：threshold=1 不得单轮即收敛', () => {
  const idle: RoundSignature = { filesDelta: 0, resultDigest: 'same', allFailed: false, hasNoSignal: false };

  it('threshold=1：首轮无变化不得判收敛', () => {
    const d = new ConvergenceDetector(1);
    const v = d.record(idle);
    expect(v.converged).toBe(false);
  });

  it('threshold=1：至少要到第 2 轮相同签名才收敛', () => {
    const d = new ConvergenceDetector(1);
    expect(d.record(idle).converged).toBe(false);
    expect(d.record(idle).converged).toBe(true);
  });

  it('threshold=0：关闭语义不变，永不收敛', () => {
    const d = new ConvergenceDetector(0);
    for (let i = 0; i < 6; i += 1) expect(d.record(idle).converged).toBe(false);
  });

  it('threshold=3：既有行为不变（首轮 streak=1，第 3 轮收敛）', () => {
    const d = new ConvergenceDetector(3);
    expect(d.record(idle)).toEqual({ streak: 1, converged: false });
    expect(d.record(idle)).toEqual({ streak: 2, converged: false });
    expect(d.record(idle)).toEqual({ streak: 3, converged: true });
  });
});
