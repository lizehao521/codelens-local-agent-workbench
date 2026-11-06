/**
 * B · 收敛判据：空转 3 轮停 / 连续写入不停 / 恰好第 N 轮有改动则重置。
 * 签名来自 RunState 相邻快照差异，模型自述不参与。
 */

import { describe, expect, it } from 'vitest';
import {
  ConvergenceDetector,
  buildRoundSignature,
  type RoundSignature,
} from '../src/services/agent/convergence-detector.js';

const idle: RoundSignature = { filesDelta: 0, resultDigest: 'same' };

describe('B · ConvergenceDetector', () => {
  it('空转：连续 3 轮无变化 → 第 3 轮判收敛', () => {
    const d = new ConvergenceDetector(3);
    expect(d.record(idle)).toEqual({ streak: 1, converged: false });
    expect(d.record(idle)).toEqual({ streak: 2, converged: false });
    expect(d.record(idle)).toEqual({ streak: 3, converged: true });
  });

  it('反例：连续 3 轮都有写入 → 不得停', () => {
    const d = new ConvergenceDetector(3);
    const writing: RoundSignature = { filesDelta: 1, resultDigest: 'write' };
    for (let i = 0; i < 3; i += 1) {
      const v = d.record(writing);
      expect(v.streak).toBe(0);
      expect(v.converged).toBe(false);
    }
  });

  it('边界：刚好第 N 轮产生改动 → 计时重置', () => {
    const d = new ConvergenceDetector(3);
    expect(d.record(idle)).toMatchObject({ streak: 1, converged: false });
    expect(d.record(idle)).toMatchObject({ streak: 2, converged: false });
    // 第 3 轮出现写入：清零
    expect(d.record({ filesDelta: 1, resultDigest: 'changed' })).toEqual({ streak: 0, converged: false });
    expect(d.record(idle)).toMatchObject({ streak: 1, converged: false });
    expect(d.record(idle)).toMatchObject({ streak: 2, converged: false });
    expect(d.record(idle)).toMatchObject({ streak: 3, converged: true });
  });

  it('金丝雀：工具结果 digest 变化（即使无写入）也不得判收敛', () => {
    const d = new ConvergenceDetector(3);
    d.record({ filesDelta: 0, resultDigest: 'a' });
    d.record({ filesDelta: 0, resultDigest: 'b' });
    const v = d.record({ filesDelta: 0, resultDigest: 'b' });
    expect(v.streak).toBe(1);
    expect(v.converged).toBe(false);
  });

  it('threshold=0 时关闭收敛判定', () => {
    const d = new ConvergenceDetector(0);
    for (let i = 0; i < 5; i += 1) expect(d.record(idle).converged).toBe(false);
  });
});

describe('B · buildRoundSignature（来自 RunState 真实差异）', () => {
  it('切片只统计本轮新增工具与文件改动', () => {
    const state = {
      tools: [
        { callId: 'c1', name: 'fs.read', status: 'success' as const, resultSummary: 'old', errorCode: null },
        { callId: 'c2', name: 'fs.read', status: 'success' as const, resultSummary: 'same', errorCode: null },
      ],
      fileChanges: [
        { path: 'a.txt' },
        { path: 'b.txt' },
      ],
    };
    // 本轮从偏移 1/1 开始：只看到 c2 与 b.txt。
    const sig = buildRoundSignature(state as never, 1, 1);
    expect(sig.filesDelta).toBe(1);
    expect(sig.resultDigest).toBeTruthy();
  });
});
