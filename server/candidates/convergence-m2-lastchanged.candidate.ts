import { describe, expect, it } from 'vitest';
import { ConvergenceDetector, type RoundSignature } from '../src/services/agent/convergence-detector.js';

/**
 * M2 判据：结果变化轮不得被 lastChanged 掩盖。
 *
 * 红队 TASK-002 finding[3] 指控「lastChanged 掩盖连续变化导致最终误判收敛」。
 * 督导核实：红队的推演（变化轮 streak 一直累加到阈值）不成立——
 *   changed=false 会把 lastChanged 翻回 false，下一轮 digest 变化会被识别，
 *   streak 在 0/1 震荡，连续变化轮「永不收敛」。这部分是误报，必须保持。
 *
 * 但契约违背真实存在，只是危害形态不同：
 *   类注释第 6 行「任何一轮出现写入或结果变化都会把计数清零」，
 *   而 record() 第 92-95 行在 lastChanged=true 时忽略 digest 变化 ——
 *   变化轮被当作无变化轮累加，导致收敛「提前一轮」触发。
 *
 * 本判据双向钉死：
 *   - 变化轮必须清零计数（抓真缺陷，当前实现 FAIL）
 *   - 连续变化轮永不收敛（钉死红队误报部分，当前实现 PASS，修复不得破坏）
 */
const sig = (digest: string, filesDelta = 0): RoundSignature => ({
  filesDelta,
  resultDigest: digest,
  allFailed: false,
  hasNoSignal: false,
});

describe('收敛判定 M2：结果变化轮不得被 lastChanged 掩盖', () => {
  it('变化轮之后：digest 变化应清零计数，不得累加', () => {
    const d = new ConvergenceDetector(3);
    d.record(sig('A', 1)); // 第 1 轮有文件改动 → 新基线，streak=0
    const v2 = d.record(sig('B')); // 第 2 轮无文件改动但结果变化 → 应清零
    // 契约「任何结果变化都清零」期望 streak=0；当前 lastChanged 逻辑给 1。
    expect(v2.streak).toBe(0);
  });

  it('变化被掩盖会导致提前一轮收敛', () => {
    const d = new ConvergenceDetector(3);
    d.record(sig('A', 1));
    d.record(sig('B')); // 真实变化，应清零但未清零
    d.record(sig('B'));
    const v4 = d.record(sig('B'));
    // 正确语义：变化轮重置计数，第 3/4/5 轮稳定才收敛 → 第 4 轮 streak 应为 2。
    expect(v4.streak).toBe(2);
    expect(v4.converged).toBe(false); // 当前实现第 4 轮即 converged=true（提前一轮）
  });

  it('纯稳定序列：threshold=3 第 3 轮照常收敛（回归保护）', () => {
    const d = new ConvergenceDetector(3);
    expect(d.record(sig('S')).streak).toBe(1);
    expect(d.record(sig('S')).streak).toBe(2);
    expect(d.record(sig('S'))).toEqual({ streak: 3, converged: true });
  });

  it('连续 digest 变化：任何一轮都不得收敛（钉死红队误报部分）', () => {
    const d = new ConvergenceDetector(3);
    for (const dg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      expect(d.record(sig(dg)).converged).toBe(false);
    }
  });

  it('threshold=0：关闭语义不变，永不收敛', () => {
    const d = new ConvergenceDetector(0);
    for (let i = 0; i < 6; i += 1) expect(d.record(sig('S')).converged).toBe(false);
  });
});
