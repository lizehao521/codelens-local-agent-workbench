// 试用锁定 + 上游故障降级的回归用例（本轮重点：零配置首跑不再 401 白屏）
// 覆盖：锁定优先级、重试只对连接类失败、超时/不可达的诊断文案、模型不存在的分支、启动自检。

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAICompatibleAdapter,
  describeHttpError,
  type ChatParams,
} from '../src/providers/openai-compatible.adapter.js';
import { resolveTrialTarget } from '../src/services/agent/agent-loop.service.js';
import { TrialHealthService } from '../src/services/agent/trial-health.service.js';

const FAKE_KEY = 'sk-testkey1234567890';
const HOST = 'api.example.com';

function params(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    baseUrl: `https://${HOST}/v1`,
    apiKey: FAKE_KEY,
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.3,
    maxTokens: 2048,
    stream: true,
    ...overrides,
  };
}

function sseResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) {
    /* consume */
  }
}

describe('resolveTrialTarget —— 试用锁定的优先级', () => {
  it('无 BYOK Key 的兜底请求被锁到服务端指定上游与模型（修复 401 根因）', () => {
    const target = resolveTrialTarget(
      { provider: 'deepseek', model: 'deepseek-chat' },
      true,
      { provider: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b' },
    );
    expect(target).toEqual({
      provider: 'nvidia',
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
      customBaseUrl: undefined,
    });
  });

  it('自带 Key 的用户不被锁定：请求里的 provider/model 原样保留', () => {
    const target = resolveTrialTarget(
      { provider: 'moonshot', model: 'kimi-k2' },
      false,
      { provider: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b' },
    );
    expect(target).toEqual({ provider: 'moonshot', model: 'kimi-k2', customBaseUrl: undefined });
  });

  it('锁定项带 baseUrl 时覆盖 customBaseUrl（自建网关作为可配置上游）', () => {
    const target = resolveTrialTarget(
      { provider: 'deepseek', model: 'deepseek-chat', customBaseUrl: 'https://old/v1' },
      true,
      { provider: 'custom', model: 'gateway-model', baseUrl: 'https://gateway.example/v1' },
    );
    expect(target.provider).toBe('custom');
    expect(target.model).toBe('gateway-model');
    expect(target.customBaseUrl).toBe('https://gateway.example/v1');
  });

  it('锁定项没配 baseUrl 时丢弃请求里的 customBaseUrl（服务端 Key 绝不发往用户指定地址）', () => {
    const target = resolveTrialTarget(
      { provider: 'deepseek', model: 'deepseek-chat', customBaseUrl: 'https://mine/v1' },
      true,
      { provider: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b' },
    );
    expect(target.customBaseUrl).toBeUndefined();
  });

  it('没有锁定项时行为与历史一致（完全不动请求）', () => {
    const target = resolveTrialTarget(
      { provider: 'deepseek', model: 'deepseek-chat' },
      true,
      null,
    );
    expect(target).toEqual({ provider: 'deepseek', model: 'deepseek-chat', customBaseUrl: undefined });
  });
});

describe('OpenAICompatibleAdapter —— 重试与故障分类', () => {
  it('连接类失败按 retries 重试，成功后正常返回', async () => {
    let calls = 0;
    const adapter = new OpenAICompatibleAdapter({
      timeoutMs: 5000,
      retries: 2,
      fetchFn: async () => {
        calls += 1;
        if (calls < 3) throw new TypeError('fetch failed');
        return sseResponse();
      },
    });
    await drain(adapter.stream(params(), 'deepseek'));
    expect(calls).toBe(3);
  });

  it('401 不重试：重复失败只会拖长用户等待，且文案给出认证引导', async () => {
    let calls = 0;
    const adapter = new OpenAICompatibleAdapter({
      retries: 3,
      fetchFn: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    await expect(drain(adapter.stream(params(), 'deepseek'))).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
    expect(calls).toBe(1);
  });

  it('超时文案包含上游主机与等待秒数（可诊断、不裸报错）', async () => {
    const adapter = new OpenAICompatibleAdapter({
      timeoutMs: 50,
      fetchFn: () => new Promise<Response>(() => {}),
    });
    await expect(drain(adapter.stream(params(), 'deepseek'))).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
    await expect(drain(adapter.stream(params(), 'deepseek'))).rejects.toThrow(
      new RegExp(`上游（${HOST}）在 \\d+(?:\\.\\d+)?s 内没有响应`),
    );
  });

  it('网络不可达文案指向上游主机，且不泄露 key', async () => {
    const adapter = new OpenAICompatibleAdapter({
      retries: 0,
      fetchFn: async () => {
        throw new TypeError(`connect ECONNREFUSED (key=${FAKE_KEY})`);
      },
    });
    await expect(drain(adapter.stream(params(), 'deepseek'))).rejects.toThrow(
      new RegExp(`无法连接上游（${HOST}）`),
    );
    try {
      await drain(adapter.stream(params(), 'deepseek'));
    } catch (err) {
      expect((err as Error).message).not.toContain(FAKE_KEY);
    }
  });
});

describe('describeHttpError —— 本轮新增分支', () => {
  it('404 / model_not_found 归到「不认识这个模型」并给出下一步', () => {
    const msg = describeHttpError(
      404,
      JSON.stringify({ error: { message: 'model "foo" not found', code: 'model_not_found' } }),
      'sk-x',
    );
    expect(msg).toContain('不认识这个模型');
    expect(msg).toContain('设置 → Provider');
    expect(msg).toContain('自带 API Key');
  });

  it('传入 baseUrl 时错误文案带上上游主机（不泄露路径与 key）', () => {
    const msg = describeHttpError(401, '{"error":{"message":"invalid api key"}}', 'sk-x', `https://${HOST}/v1`);
    expect(msg).toContain(`上游（${HOST}）认证失败`);
    expect(msg).not.toContain('/v1');
  });
});

describe('TrialHealthService —— R4 真实最小生成探测（三态 + 缓存）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeService(overrides: Partial<{ timeoutMs: number; cacheMs: number }> = {}) {
    return new TrialHealthService({
      baseUrl: `https://${HOST}/v1`,
      apiKey: FAKE_KEY,
      model: 'probe-model',
      ...overrides,
    });
  }

  it('真实 chat 探测成功 → ok，并记录耗时与 token 用量', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 1 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const service = makeService();
    const state = await service.checkOnce();
    expect(state.status).toBe('ok');
    expect(state.detail).toBeNull();
    expect(state.tokens).toEqual({ promptTokens: 3, completionTokens: 1 });
    expect(state.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof state.checkedAt).toBe('number');
  });

  it('错误 Key（401）→ auth_failed，而不是假绿 ok；detail 不含 key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"invalid api key"}}', { status: 401 })));
    const state = await makeService().checkOnce();
    expect(state.status).toBe('auth_failed');
    expect(state.status).not.toBe('ok');
    expect(state.detail).toContain('401');
    expect(state.detail).not.toContain(FAKE_KEY);
  });

  it('403 同样归到 auth_failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));
    const state = await makeService().checkOnce();
    expect(state.status).toBe('auth_failed');
  });

  it('网络异常 → unreachable，不抛异常打断启动', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const state = await makeService().checkOnce();
    expect(state.status).toBe('unreachable');
    expect(state.detail).toContain('不可达');
  });

  it('超时（TimeoutError）→ unreachable，文案标明超时', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('timeout');
        err.name = 'TimeoutError';
        throw err;
      }),
    );
    const state = await makeService().checkOnce();
    expect(state.status).toBe('unreachable');
    expect(state.detail).toContain('超时');
  });

  it('其它非 2xx（500）→ unreachable，带状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const state = await makeService().checkOnce();
    expect(state.status).toBe('unreachable');
    expect(state.detail).toContain('500');
  });

  it('探测请求是最小非流式生成：POST /chat/completions + max_tokens=1 + stream=false', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await makeService().checkOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${HOST}/v1/chat/completions`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(1);
    expect(body.stream).toBe(false);
    expect(body.model).toBe('probe-model');
  });

  it('5 分钟内命中缓存不重复探测；force 才发新请求', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const service = makeService({ cacheMs: 5 * 60_000 });
    await service.checkOnce();
    const cached = await service.checkOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cached.cached).toBe(true);
    await service.checkOnce(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('未配置试用上游（cfg=null）时保持 unknown，不发请求', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const service = new TrialHealthService(null);
    const state = await service.checkOnce();
    expect(state.status).toBe('unknown');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ok 态不触发后台复探（成功的缓存仍有意义）', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const service = makeService();
    await service.checkOnce();
    expect(service.refreshIfStaleFailure()).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('失败态超过复探窗口后读取会触发一次复探，上游恢复即转 ok（不等满 5 分钟）', async () => {
    let calls = 0;
    const fetchSpy = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response('{}', { status: 500 })
        : new Response(JSON.stringify({ usage: { prompt_tokens: 2, completion_tokens: 1 } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const service = makeService({ cacheMs: 5 * 60_000 });
    const first = await service.checkOnce();
    expect(first.status).toBe('unreachable');

    // 窗口内（刚探测完）：不重复打上游
    expect(service.refreshIfStaleFailure()).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 超窗：后台复探，转 ok
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 30_000);
    const pending = service.refreshIfStaleFailure();
    expect(pending).not.toBeNull();
    await pending;
    vi.useRealTimers();

    expect(service.get().status).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('复探单飞：在飞期间的再次读取不会叠加请求', async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const fetchSpy = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve(new Response('{}', { status: 500 })) : gate;
    });
    vi.stubGlobal('fetch', fetchSpy);
    const service = makeService();
    await service.checkOnce();

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 30_000);
    const pending = service.refreshIfStaleFailure();
    expect(pending).not.toBeNull();
    // 复探在飞（fetch 第二次未 resolve）→ 再读取不再发请求
    expect(service.refreshIfStaleFailure()).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    release(new Response('{}', { status: 200 }));
    await pending;
    vi.useRealTimers();
    expect(service.refreshIfStaleFailure()).toBeNull();
  });
});
