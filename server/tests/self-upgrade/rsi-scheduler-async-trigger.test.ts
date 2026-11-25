import { describe, it, expect, vi } from 'vitest';
import { RsiSchedulerService } from '../../src/services/rsi/scheduler.service.js';

/**
 * 判据：RSI scheduler 异步触发入口的契约。
 *
 * 背景：rsi.exec 有 60s 硬超时，重脚本（self-upgrade-loop，含上游限流重试 20s/40s）
 * 塞不进去 → 连续失败 → 熔断。triggerAsync 必须：
 *   1) 同步立即返回受理回执（不 await 后台循环）；
 *   2) 并发保护：上一轮在途时 accepted=false（幂等，避免 agent 重试到熔断）；
 *   3) 回执含 runId / statusUrl，供调用方轮询观测。
 */

function makeService(): RsiSchedulerService {
  // db 只需满足 logRun 不抛；后台 trigger 被 spy 拦截，不会真落库/真 spawn。
  const db = { run: vi.fn() } as unknown as ConstructorParameters<typeof RsiSchedulerService>[0];
  return new RsiSchedulerService(db);
}

describe('RsiSchedulerService.triggerAsync contract', () => {
  it('returns an accepted receipt synchronously without awaiting the loop', () => {
    const svc = makeService();
    // 用永不 resolve 的 promise 模拟“后台仍在跑”，确保 triggerAsync 不 await 它。
    let resolveLoop!: () => void;
    vi.spyOn(svc as never, 'trigger').mockReturnValue(new Promise((r) => { resolveLoop = () => r({ ok: true, output: '' }); }) as never);

    const t0 = Date.now();
    const res = svc.triggerAsync('judge-async');
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(100); // 同步返回，不能被后台循环阻塞
    expect(res.accepted).toBe(true);
    expect(res.reason).toBe('judge-async');
    expect(res.runId).toMatch(/^async-/);
    expect(res.statusUrl).toBe('/api/v1/rsi/scheduler/status');

    resolveLoop(); // 释放后台，让 finally 回收 inFlight
  });

  it('rejects a second call while one is in flight (idempotent, prevents retry storm)', async () => {
    const svc = makeService();
    let resolveLoop!: () => void;
    const spy = vi.spyOn(svc as never, 'trigger').mockReturnValue(new Promise((r) => { resolveLoop = () => r({ ok: true, output: '' }); }) as never);

    const first = svc.triggerAsync('first');
    const second = svc.triggerAsync('second');

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe('busy');
    expect(spy).toHaveBeenCalledTimes(1); // 后台只启动一次

    resolveLoop();
    await new Promise((r) => setImmediate(r)); // 等 finally 释放 inFlight
  });

  it('accepts again after the in-flight loop finishes', async () => {
    const svc = makeService();
    vi.spyOn(svc as never, 'trigger').mockResolvedValue({ ok: true, output: '' } as never);

    const first = svc.triggerAsync('round-1');
    expect(first.accepted).toBe(true);
    // 等后台 promise 链（trigger().catch().finally()）释放闸
    await new Promise((r) => setTimeout(r, 20));

    const second = svc.triggerAsync('round-2');
    expect(second.accepted).toBe(true);
  });
});
