/**
 * 兜底 API Key 失败自动切换的轮换测试。
 *
 * 覆盖三条不变量：
 * 1. 请求 key 命中池时，401/429 自动换下一个 key 重试，直到成功；
 * 2. 所有 key 均失败时抛汇总错误，且报文不泄露池中任一 key；
 * 3. BYOK 自带 key（不在池中）与单 key 池：行为零变化，绝不顶替用户 key。
 */
import { describe, expect, it } from 'vitest';
import { OpenAICompatibleAdapter } from '../src/providers/openai-compatible.adapter.js';
import type { ChatParams } from '../src/providers/openai-compatible.adapter.js';

function params(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKey: 'key-A',
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.3,
    maxTokens: 64,
    stream: true,
    ...overrides,
  };
}

function okResponse(): Response {
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

function authError(status = 401): Response {
  return new Response(JSON.stringify({ error: { message: 'invalid key key-B' } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authOf(init?: RequestInit): string {
  return (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
}

describe('兜底 API Key 失败自动切换', () => {
  it('命中池的 key 遇 401/429 时按顺序换 key 重试，直到成功', async () => {
    const seen: string[] = [];
    const statuses = [401, 429, 200];
    let call = 0;
    const adapter = new OpenAICompatibleAdapter({
      apiKeyPool: ['key-A', 'key-B', 'key-C'],
      fetchFn: async (_url, init) => {
        seen.push(authOf(init));
        return statuses[call++] === 200 ? okResponse() : authError(statuses[call - 1]);
      },
    });
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    for await (const event of adapter.stream(params({ apiKey: 'key-A' }), 'nvidia')) events.push(event);
    expect(seen).toEqual(['Bearer key-A', 'Bearer key-B', 'Bearer key-C']);
    expect(events.some((e) => e.type === 'delta')).toBe(true);
  });

  it('从池中命中位置开始轮一圈（key-B 起 → B、C、A）', async () => {
    const seen: string[] = [];
    const adapter = new OpenAICompatibleAdapter({
      apiKeyPool: ['key-A', 'key-B', 'key-C'],
      fetchFn: async (_url, init) => {
        seen.push(authOf(init));
        return seen.length < 3 ? authError() : okResponse();
      },
    });
    for await (const _e of adapter.stream(params({ apiKey: 'key-B' }), 'nvidia')) { /* drain */ }
    expect(seen).toEqual(['Bearer key-B', 'Bearer key-C', 'Bearer key-A']);
  });

  it('全部 key 失败时抛汇总错误，且报文不泄露池中任一 key', async () => {
    const adapter = new OpenAICompatibleAdapter({
      apiKeyPool: ['secret-A-xyz', 'secret-B-xyz'],
      fetchFn: async () => authError(),
    });
    let message = '';
    try {
      for await (const _e of adapter.stream(params({ apiKey: 'secret-A-xyz' }), 'nvidia')) { /* drain */ }
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/全部 2 个 API Key 均不可用/);
    expect(message).not.toContain('secret-A-xyz');
    expect(message).not.toContain('secret-B-xyz');
  });

  it('BYOK 自带 key 不在池中：不换 key，401 原样上报', async () => {
    const seen: string[] = [];
    const adapter = new OpenAICompatibleAdapter({
      apiKeyPool: ['server-key-1', 'server-key-2'],
      fetchFn: async (_url, init) => {
        seen.push(authOf(init));
        return authError();
      },
    });
    let message = '';
    try {
      for await (const _e of adapter.stream(params({ apiKey: 'my-byok-key' }), 'custom')) { /* drain */ }
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // 只请求一次，绝不拿服务端 key 顶替用户 key。
    expect(seen).toEqual(['Bearer my-byok-key']);
    expect(message).not.toContain('server-key-1');
  });

  it('单 key（未配池）：401 只请求一次，行为与旧版一致', async () => {
    let calls = 0;
    const adapter = new OpenAICompatibleAdapter({
      apiKeyPool: ['only-key'],
      fetchFn: async () => {
        calls += 1;
        return authError();
      },
    });
    try {
      for await (const _e of adapter.stream(params({ apiKey: 'only-key' }), 'custom')) { /* drain */ }
    } catch { /* expected */ }
    expect(calls).toBe(1);
  });

  it('非轮换状态码（如 400）不换 key，原样上报', async () => {
    let calls = 0;
    const adapter = new OpenAICompatibleAdapter({
      apiKeyPool: ['key-A', 'key-B'],
      fetchFn: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 });
      },
    });
    try {
      for await (const _e of adapter.stream(params({ apiKey: 'key-A' }), 'custom')) { /* drain */ }
    } catch { /* expected */ }
    expect(calls).toBe(1);
  });
});
