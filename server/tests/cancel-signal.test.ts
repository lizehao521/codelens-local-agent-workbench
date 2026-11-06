/**
 * R5 回归：取消/超时信号必须是一条贯通管道。
 *
 * 背景（实测）：等待首事件期间中止，上游能力探测请求没有随 abort 取消，
 * 白跑 4,982 ms 才结束。根因不是漏了某个 if，而是 signal 没从 controller
 * 统一传到 adapter / probe，各处手工补。
 *
 * 这组用例钉住五件事：
 *   1. abort 传到 probe（及 adapter 的 fetch）；
 *   2. abort 幂等（重复中止不重复触发、不产生第二次副作用）；
 *   3. timeout 取消在途请求（不是“等它自己结束”）；
 *   4. shutdown 取消在途 run（进程退出不靠上游超时）；
 *   5. 已销毁响应不再写入（沿用 SSE 的销毁保护）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { OpenAICompatibleAdapter, type ChatParams } from '../src/providers/openai-compatible.adapter.js';
import { ChannelRouter } from '../src/services/agent/channel-router.service.js';
import { AbortRegistry } from '../src/services/agent/abort-registry.js';
import { RunCancellation, describeCancel } from '../src/services/agent/run-cancel.js';
import { SseWriter } from '../src/services/agent/sse-writer.js';
import type { ProviderCapabilityRepository } from '../src/services/memory/provider-capability.repository.js';
import { FakeLlm } from './fixtures/fake-llm.js';
import { runAgentStream, postJson } from './fixtures/agent-http.js';

const PARAMS: ChatParams = {
  baseUrl: 'https://up.example.com/v1',
  apiKey: 'sk-test',
  model: 'm',
  messages: [{ role: 'user', content: 'ping' }],
  temperature: 0,
  maxTokens: 16,
  stream: false,
};

/** 一个永不返回的 fetch：只有 signal abort 时才拒绝（模拟上游长尾）。 */
function hangingFetch(observed: { abortedAt: number | null; clientSignal: AbortSignal | null }) {
  return (_url: string, init: RequestInit): Promise<Response> => {
    const signal = init.signal as AbortSignal;
    observed.clientSignal = signal;
    return new Promise<Response>((_resolve, reject) => {
      const onAbort = (): void => {
        observed.abortedAt = Date.now();
        reject(new DOMException('aborted', 'AbortError'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  };
}

describe('adapter · probe 随 signal 取消', () => {
  it('abort 后 probe 立刻返回 cancelled，并把 abort 传给 fetch', async () => {
    const observed = { abortedAt: null as number | null, clientSignal: null as AbortSignal | null };
    const adapter = new OpenAICompatibleAdapter({ fetchFn: hangingFetch(observed), timeoutMs: 5000 });
    const controller = new AbortController();
    const started = Date.now();
    const pending = adapter.probeToolSupport(PARAMS, controller.signal);
    setTimeout(() => controller.abort(), 30);

    const outcome = await pending;
    const elapsed = Date.now() - started;

    expect(outcome).toEqual({ status: 'cancelled', evidence: 'aborted' });
    // 关键：不是等 5s 超时，而是在 abort 后很快返回。
    // 阈值取 2000ms 而不是 500ms：这条断言证明的是「提前返回」，不是「毫秒级调度」。
    // 全量并行（约 98 个 worker 抢占 CPU + 宿主删除守卫）下，事件循环排队会让
    // 30ms 的 abort 回调实测到 600–700ms，500ms 会把纯负载抖动误判成回归；
    // 2000ms 仍远小于 5000ms 的 timeoutMs，判据不变、抗噪更强。
    expect(elapsed).toBeLessThan(2000);
    expect(observed.clientSignal?.aborted).toBe(true);
    expect(observed.abortedAt).not.toBeNull();
  });

  it('run 级 signal 已取消时，probe 不再发起请求', async () => {
    const fetchFn = vi.fn(async () => new Response('{}'));
    const adapter = new OpenAICompatibleAdapter({ fetchFn, timeoutMs: 5000 });
    const controller = new AbortController();
    controller.abort();

    const outcome = await adapter.probeToolSupport(PARAMS, controller.signal);

    expect(outcome).toEqual({ status: 'cancelled', evidence: 'aborted' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('adapter · abort 与 timeout 不互相冒充', () => {
  it('timeout 取消在途请求，并报 UPSTREAM_TIMEOUT', async () => {
    const observed = { abortedAt: null as number | null, clientSignal: null as AbortSignal | null };
    const adapter = new OpenAICompatibleAdapter({ fetchFn: hangingFetch(observed), timeoutMs: 120 });
    const started = Date.now();

    await expect(adapter.chat(PARAMS)).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });

    const elapsed = Date.now() - started;
    // 在途请求被 timeout 真正中断，而不是等上游自己结束。
    expect(elapsed).toBeLessThan(1000);
    expect(observed.clientSignal?.aborted).toBe(true);
    expect(observed.abortedAt).not.toBeNull();
  });

  it('外部 abort 不报超时（文案指向“已取消”）', async () => {
    const observed = { abortedAt: null as number | null, clientSignal: null as AbortSignal | null };
    const adapter = new OpenAICompatibleAdapter({ fetchFn: hangingFetch(observed), timeoutMs: 5000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    await expect(adapter.chat(PARAMS, undefined, controller.signal)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: expect.stringContaining('取消'),
    });
  });
});

describe('ChannelRouter · 取消不是能力结论', () => {
  it('abort 后 probe 返回 cancelled，且不写能力表', async () => {
    const observed = { abortedAt: null as number | null, clientSignal: null as AbortSignal | null };
    const adapter = new OpenAICompatibleAdapter({ fetchFn: hangingFetch(observed), timeoutMs: 5000 });
    const upsert = vi.fn();
    const capabilities = {
      get: () => undefined,
      upsert,
    } as unknown as ProviderCapabilityRepository;
    const router = new ChannelRouter(adapter, capabilities);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const result = await router.probe('custom', 'm', 'k', 'https://up.example.com/v1', controller.signal);

    expect(result.status).toBe('cancelled');
    // 把 abort 缓存成 supported/unsupported/failed 都会污染后续决策。
    expect(upsert).not.toHaveBeenCalled();
  });

  it('decide 在取消时不标记 degraded（取消不是“探测未通过”）', async () => {
    const adapter = new OpenAICompatibleAdapter({
      fetchFn: hangingFetch({ abortedAt: null, clientSignal: null }),
      timeoutMs: 5000,
    });
    const router = new ChannelRouter(adapter, {
      get: () => undefined,
      upsert: vi.fn(),
    } as unknown as ProviderCapabilityRepository);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const decision = await router.decide('auto', 'custom', 'm', 'k', 'https://up.example.com/v1', controller.signal);

    expect(decision.degraded).toBe(false);
    expect(decision.degradedReason).toBeNull();
  });
});

describe('RunCancellation · 幂等与归因', () => {
  it('重复 cancel 只生效一次，reason 先到先得', () => {
    const cancel = new RunCancellation();
    const events: string[] = [];
    cancel.signal.addEventListener('abort', () => events.push('abort'));

    expect(cancel.cancel('abort')).toBe(true);
    expect(cancel.cancel('shutdown')).toBe(false);

    expect(events).toHaveLength(1);
    expect(cancel.reason).toBe('abort');
  });

  it('shutdown 源单独可区分（文案不写成用户中止）', () => {
    const shutdown = new AbortController();
    const cancel = new RunCancellation().link(shutdown.signal, 'shutdown');
    shutdown.abort();

    expect(cancel.reason).toBe('shutdown');
    expect(describeCancel(cancel.reason)).toContain('服务正在关闭');
  });

  it('link 一个已取消的源会立即取消', () => {
    const source = new AbortController();
    source.abort();
    const cancel = new RunCancellation().link(source.signal, 'abort');
    expect(cancel.cancelled).toBe(true);
  });
});

describe('AbortRegistry · 重复 abort 幂等', () => {
  it('第一次 true，第二次 false，signal 只触发一次', () => {
    const registry = new AbortRegistry();
    const controller = registry.register('s1');
    let fired = 0;
    controller.signal.addEventListener('abort', () => {
      fired += 1;
    });

    expect(registry.abort('s1')).toBe(true);
    expect(registry.abort('s1')).toBe(false);
    expect(fired).toBe(1);
    registry.release('s1');
  });
});

describe('SseWriter · 已销毁响应不写', () => {
  it('res.destroyed 后 emit / emitStage 均为空操作且不抛错', () => {
    const writes: string[] = [];
    const res = {
      destroyed: true,
      writableEnded: false,
      status() {
        return this;
      },
      set() {
        return this;
      },
      write(chunk: string) {
        writes.push(chunk);
      },
      end() {
        /* noop */
      },
    };
    const writer = new SseWriter(res as never);

    expect(() => writer.beginRunStage()).not.toThrow();
    writer.emitStage('connecting');
    writer.emit('delta', { text: 'x' });
    writer.close();

    expect(writes).toEqual([]);
  });
});

describe('e2e · 等待首事件期间中止 → 探测请求随之取消', () => {
  let fake: FakeLlm;
  let runtime: Runtime;
  let server: http.Server | undefined;
  let base: string;
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'codelens-cancel-'));
    runtime = createRuntime({ dbPath: path.join(tmpRoot, 'cancel.db'), upstreamMaxRetries: 0 });
    const app = createApp({ runtime, autoStartModelSync: false });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    fake = await FakeLlm.start();
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
        server!.closeAllConnections();
      });
    }
    await fake?.close();
    await runtime?.close();
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it(
    '中止后探测连接在 ≤1s 内关闭、能力表无残留，且同会话立刻再发请求可正常完成',
    { timeout: 30_000 },
    async () => {
      const created = await postJson(base, '/api/v1/sessions', { provider: 'custom', model: 'fake-model-1' });
      const sessionId = created.body?.session?.id as string;
      expect(sessionId).toBeTruthy();

      fake.probeStall = true;
      fake.script([{ text: 'ok' }]);

      const controller = new AbortController();
      const res = await fetch(`${base}/api/v1/agent/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          sessionId,
          provider: 'custom',
          customBaseUrl: fake.baseUrl,
          model: 'fake-model-1',
          apiKey: 'test-key-cancel',
          message: '在探测期间中止',
          channelMode: 'auto',
          tools: [],
          maxIterations: 5,
          temperature: 0,
          maxTokens: 128,
        }),
      });
      const reader = res.body!.getReader();
      await reader.read(); // 至少收到 connecting 帧

      // 等到探测请求真的发出去，再模拟用户点击“停止”。
      const deadline = Date.now() + 3000;
      while (fake.probeRequests === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(fake.probeRequests).toBeGreaterThan(0);

      const abortAt = Date.now();
      controller.abort();

      const releaseDeadline = Date.now() + 3000;
      while (fake.abortedRequests === 0 && Date.now() < releaseDeadline) {
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(fake.abortedRequests).toBeGreaterThan(0);
      expect((fake.lastAbortAt ?? Number.POSITIVE_INFINITY) - abortAt).toBeLessThan(1000);
      // 取消不是能力结论：能力表不得留下探测结果。
      const row = runtime.db.get<{ probe_status: string }>(
        'SELECT probe_status FROM provider_capabilities WHERE provider = ? AND model = ?',
        ['custom', 'fake-model-1'],
      );
      expect(row).toBeUndefined();

      // 同会话立刻再发一次：registry 已释放，不应被上一轮挡住。
      fake.probeStall = false;
      let done = false;
      const second = await runAgentStream(
        base,
        {
          sessionId,
          provider: 'custom',
          customBaseUrl: fake.baseUrl,
          model: 'fake-model-1',
          apiKey: 'test-key-cancel',
          message: '再来一次',
          channelMode: 'native',
          tools: [],
          maxIterations: 5,
          temperature: 0,
          maxTokens: 128,
        },
        (event) => {
          if (event.name === 'done') done = true;
        },
      );
      expect(second.status).toBe(200);
      expect(done).toBe(true);
      expect(runtime.abortRegistry.isActive(sessionId)).toBe(false);
    },
  );
});
