import { describe, expect, it } from 'vitest';
import { ConvergenceDetector, buildRoundSignature } from '../src/services/agent/convergence-detector.js';

describe('收敛判定：失败循环不得误判收敛', () => {
  const threshold = 3;

  function makeState(tools: Array<{ callId: string; name: string; status: 'success' | 'failed' | 'timeout' | 'rejected' | 'skipped'; resultSummary?: string | null; errorCode?: string | null }>, fileChanges: number = 0) {
    return {
      tools: tools.map(t => ({
        callId: t.callId,
        name: t.name,
        iteration: 1,
        status: t.status,
        startedAt: Date.now(),
        durationMs: 10,
        risk: 'low' as const,
        approvalMode: 'none' as const,
        effectReversible: null,
        resultSummary: t.resultSummary ?? null,
        errorCode: t.errorCode ?? null,
      })),
      fileChanges: Array.from({ length: fileChanges }, (_, i) => ({
        path: `file${i}.ts`,
        step: 1,
        checkpointId: null,
        beforeSha256: null,
        afterSha256: null,
        added: 10,
        removed: 5,
      })),
    };
  }

  it('连续失败轮（相同 invalid_args）不累加收敛计数，不得报 converged', () => {
    const detector = new ConvergenceDetector(threshold);
    const failedTools = [
      { callId: 'c1', name: 'fs_write', status: 'failed' as const, errorCode: 'invalid_args', resultSummary: '参数 JSON 不完整' },
      { callId: 'c2', name: 'fs_write', status: 'failed' as const, errorCode: 'invalid_args', resultSummary: '参数 JSON 不完整' },
    ];

    // 第 1 轮失败
    const sig1 = buildRoundSignature(makeState(failedTools), 0, 0);
    const v1 = detector.record(sig1);
    expect(v1.converged).toBe(false);
    expect(v1.streak).toBe(0); // 失败轮不计入 streak

    // 第 2 轮失败（相同错误）
    const sig2 = buildRoundSignature(makeState(failedTools), 2, 0);
    const v2 = detector.record(sig2);
    expect(v2.converged).toBe(false);
    expect(v2.streak).toBe(0);

    // 第 3 轮失败（相同错误）
    const sig3 = buildRoundSignature(makeState(failedTools), 4, 0);
    const v3 = detector.record(sig3);
    expect(v3.converged).toBe(false);
    expect(v3.streak).toBe(0);

    // 第 4 轮失败（相同错误）
    const sig4 = buildRoundSignature(makeState(failedTools), 6, 0);
    const v4 = detector.record(sig4);
    expect(v4.converged).toBe(false);
    expect(v4.streak).toBe(0);
  });

  it('混合：失败轮不累加；失败→成功是一次变化，其后连续无变化轮才累加收敛', () => {
    const detector = new ConvergenceDetector(threshold);
    const failedTools = [
      { callId: 'c1', name: 'fs_write', status: 'failed' as const, errorCode: 'invalid_args', resultSummary: '参数 JSON 不完整' },
    ];
    const successTools = [
      { callId: 'c2', name: 'fs_read', status: 'success' as const, errorCode: null, resultSummary: '读取成功' },
    ];
    // toolOffset 是「本轮新增工具起点」，不是轮次编号：每轮都是全新 state，恒传 0。
    const sig = (tools: typeof failedTools) => buildRoundSignature(makeState(tools), 0, 0);

    // 第 1 轮失败：不累加
    const v1 = detector.record(sig(failedTools));
    expect(v1.streak).toBe(0);
    expect(v1.converged).toBe(false);

    // 第 2 轮成功：摘要相对失败轮发生变化 → 计数仍为 0
    const v2 = detector.record(sig(successTools));
    expect(v2.streak).toBe(0);

    // 第 3/4 轮相同成功轮：连续无变化 → 累加 1、2
    expect(detector.record(sig(successTools)).streak).toBe(1);
    expect(detector.record(sig(successTools)).streak).toBe(2);

    // 第 5 轮相同成功轮：达到阈值收敛
    const v5 = detector.record(sig(successTools));
    expect(v5.streak).toBe(3);
    expect(v5.converged).toBe(true);
  });

  it('正常无变化轮仍正常判收敛（回归保护）', () => {
    const detector = new ConvergenceDetector(threshold);
    const tools = [
      { callId: 'c1', name: 'fs_read', status: 'success' as const, errorCode: null, resultSummary: '读取成功' },
    ];
    // 每轮传全新 state，toolOffset 恒为 0；首轮无变化即记 streak=1，第 3 轮达阈值。
    const sig = () => buildRoundSignature(makeState(tools), 0, 0);

    expect(detector.record(sig()).streak).toBe(1);
    expect(detector.record(sig()).streak).toBe(2);
    const v3 = detector.record(sig());
    expect(v3.streak).toBe(3);
    expect(v3.converged).toBe(true);
  });

  it('不同类型的失败轮（invalid_args -> not_found）视为变化，清零计数', () => {
    const detector = new ConvergenceDetector(threshold);
    const failed1 = [
      { callId: 'c1', name: 'fs_write', status: 'failed' as const, errorCode: 'invalid_args', resultSummary: '参数 JSON 不完整' },
    ];
    const failed2 = [
      { callId: 'c2', name: 'fs_write', status: 'failed' as const, errorCode: 'not_found', resultSummary: '工具不存在' },
    ];

    const sig1 = buildRoundSignature(makeState(failed1), 0, 0);
    detector.record(sig1);

    const sig2 = buildRoundSignature(makeState(failed2), 1, 0);
    const v2 = detector.record(sig2);
    // 不同 errorCode 应该被视为变化，streak 清零
    expect(v2.streak).toBe(0);
  });

  it('有文件改动的轮次即使工具失败也视为变化', () => {
    const detector = new ConvergenceDetector(threshold);
    const failedTools = [
      { callId: 'c1', name: 'fs_write', status: 'failed' as const, errorCode: 'invalid_args', resultSummary: '参数 JSON 不完整' },
    ];

    // 第 1 轮失败无文件改动
    const sig1 = buildRoundSignature(makeState(failedTools, 0), 0, 0);
    detector.record(sig1);

    // 第 2 轮失败但有文件改动
    const sig2 = buildRoundSignature(makeState(failedTools, 1), 1, 0);
    const v2 = detector.record(sig2);
    expect(v2.streak).toBe(0); // 文件改动清零
  });

  // ── 红队 TASK-002 补充的反向断言（草稿态，未 promote）──────────────────
  it('V1 反向：timeout/rejected/skipped 三种失败态均不得累加收敛', () => {
    for (const st of ['timeout', 'rejected', 'skipped'] as const) {
      const detector = new ConvergenceDetector(threshold);
      let last;
      for (let i = 0; i < 3; i++) {
        const t = { callId: 'fixed', name: 'fs_write', status: st, errorCode: null, resultSummary: 'x' };
        last = detector.record(buildRoundSignature(makeState([t], 0), 0, 0));
      }
      expect(last!.streak).toBe(0);
      expect(last!.converged).toBe(false);
    }
  });

  it('V2 反向：空工具列表 + 无文件改动连续 3 轮不得误判收敛', () => {
    const detector = new ConvergenceDetector(threshold);
    let last;
    for (let i = 0; i < 3; i++) {
      last = detector.record(buildRoundSignature(makeState([], 0), 0, 0));
    }
    expect(last!.converged).toBe(false); // 无信号不应判为正常收敛
  });

  it('回归：正常无变化 3 轮仍应收敛（不误杀真收敛）', () => {
    const detector = new ConvergenceDetector(threshold);
    let last;
    for (let i = 0; i < 3; i++) {
      const t = { callId: 'fixed', name: 'fs_write', status: 'success' as const, errorCode: null, resultSummary: 'ok' };
      last = detector.record(buildRoundSignature(makeState([t], 0), 0, 0));
    }
    expect(last!.converged).toBe(true);
  });

  // ── 红队复验 TASK-003 补充：callId 不应污染摘要 ──────────────────────
  it('N1 反向：每轮 callId 不同但语义无变化，仍应收敛', () => {
    const detector = new ConvergenceDetector(threshold);
    let last;
    for (let i = 0; i < 3; i++) {
      const t = { callId: `call-${i}`, name: 'fs_read', status: 'success' as const, errorCode: null, resultSummary: 'ok' };
      last = detector.record(buildRoundSignature(makeState([t], 0), 0, 0));
    }
    expect(last!.converged).toBe(true); // 摘要不含 callId，逻辑无变化必须收敛
  });
});