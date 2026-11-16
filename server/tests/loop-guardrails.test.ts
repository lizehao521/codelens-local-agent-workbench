// loop-guardrails 单测——循环预算 / 熔断器 / 循环检测（AC-08 / 架构 7.5）
// 三个纯状态机：预算答"继续还是停"，熔断器答"这个工具还能不能调"，
// 检测器答"是不是在重复同一个调用"。

import { describe, expect, it } from 'vitest';
import {
  canRetry,
  checkTermination,
  circuitOpenTermination,
  consumeRetry,
  createBudget,
} from '../src/services/agent/loop-budget.js';
import { CircuitBreaker } from '../src/services/agent/circuit-breaker.js';
import { LoopDetector } from '../src/services/agent/loop-detector.js';

describe('loop-budget', () => {
  it('默认值：5 次重试', () => {
    const state = createBudget();
    expect(state.maxRetries).toBe(5);
    expect(checkTermination(state).kind).toBe('continue');
  });

  it('token 用量与墙钟耗尽不再触发停止', () => {
    const state = createBudget({ startedAt: Date.now() - 10_000_000, tokenBudget: 1 });
    expect(checkTermination(state, 999_999).kind).toBe('continue');
  });

  it('aborted 优先于其他终止条件', () => {
    const state = createBudget({ startedAt: 0, aborted: true });
    state.iteration = 99;
    const result = checkTermination(state);
    expect(result.kind).toBe('stop');
    if (result.kind !== 'stop') return;
    expect(result.finishReason).toBe('aborted');
  });

  it('retry budget 5 次用尽后 canRetry 为 false', () => {
    const state = createBudget({ maxRetries: 5 });
    for (let i = 0; i < 5; i += 1) {
      expect(canRetry(state)).toBe(true);
      consumeRetry(state);
    }
    expect(canRetry(state)).toBe(false);
    expect(state.retriesUsed).toBe(5);
  });

  it('circuitOpenTermination 是 stop 且中性色文案', () => {
    const result = circuitOpenTermination('http.request');
    expect(result.kind).toBe('stop');
    if (result.kind !== 'stop') return;
    expect(result.finishReason).toBe('circuit_open');
    expect(result.detail).toContain('http.request');
  });

});

describe('circuit-breaker', () => {
  it('连续 3 次失败后第 4 次调用熔断（不经过 LLM）', () => {
    const breaker = new CircuitBreaker();
    const tool = 'http.request';
    expect(breaker.check(tool).open).toBe(false);
    breaker.recordFailure(tool);
    breaker.recordFailure(tool);
    expect(breaker.check(tool).open).toBe(false); // 第 3 次仍放行
    breaker.recordFailure(tool);
    const verdict = breaker.check(tool);
    expect(verdict.open).toBe(true);
    if (!verdict.open) return;
    expect(verdict.message).toContain('熔断');
  });

  it('一次成功清零失败计数', () => {
    const breaker = new CircuitBreaker();
    const tool = 'fs_read';
    breaker.recordFailure(tool);
    breaker.recordFailure(tool);
    breaker.recordSuccess(tool);
    breaker.recordFailure(tool);
    breaker.recordFailure(tool);
    expect(breaker.check(tool).open).toBe(false); // 只有 2 连败
  });

  it('熔断按工具名独立计数', () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('http.request');
    expect(breaker.check('http.request').open).toBe(true);
    expect(breaker.check('calc_evaluate').open).toBe(false);
  });

  it('snapshot 暴露各工具连败数', () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure('http.request');
    breaker.recordFailure('http.request');
    breaker.recordFailure('fs_read');
    expect(breaker.snapshot()).toEqual({ 'http.request': 2, fs_read: 1 });
  });
});

describe('loop-detector', () => {
  it('第 1 次 ok，第 2 次 warn，第 3 次 abort', () => {
    const detector = new LoopDetector();
    const args = { expression: '1+1' };
    expect(detector.record('calc_evaluate', args).kind).toBe('ok');
    expect(detector.record('calc_evaluate', args).kind).toBe('warn');
    const third = detector.record('calc_evaluate', args);
    expect(third.kind).toBe('abort');
    if (third.kind !== 'abort') return;
    expect(third.message).toContain('3');
    expect(detector.consecutive).toBe(3);
  });

  it('穿插不同调用会重置连击', () => {
    const detector = new LoopDetector();
    detector.record('calc_evaluate', { expression: '1+1' });
    detector.record('calc_evaluate', { expression: '1+1' });
    expect(detector.consecutive).toBe(2);
    detector.record('time_now', {});
    expect(detector.consecutive).toBe(1);
    // 连击已重置：再连击两次才重新 warn
    expect(detector.record('calc_evaluate', { expression: '1+1' }).kind).toBe('ok');
    expect(detector.record('calc_evaluate', { expression: '1+1' }).kind).toBe('warn');
  });

  it('volatile 参数变化不算不同调用（timeoutMs 被摘要剔除）', () => {
    const detector = new LoopDetector();
    expect(detector.record('http_request', { url: 'https://x.com', timeoutMs: 1000 }).kind).toBe('ok');
    expect(detector.record('http_request', { url: 'https://x.com', timeoutMs: 5000 }).kind).toBe('warn');
  });

  it('参数键序不同仍判为同一调用（摘要键序无关）', () => {
    const detector = new LoopDetector();
    detector.record('http_request', { url: 'https://x.com', method: 'GET' });
    expect(detector.record('http_request', { method: 'GET', url: 'https://x.com' }).kind).toBe('warn');
  });
});
