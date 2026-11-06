import { describe, expect, it } from 'vitest';
import { OpenAICompatibleAdapter, buildChatBody } from '../src/providers/openai-compatible.adapter.js';
import type { ChatParams } from '../src/providers/openai-compatible.adapter.js';

const FAKE_KEY = 'sk-testkey1234567890';

function params(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    baseUrl: 'https://api.example.com/v1',
    apiKey: FAKE_KEY,
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.3,
    maxTokens: 2048,
    stream: true,
    ...overrides,
  };
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function collect(gen: AsyncGenerator<{ type: string; [key: string]: unknown }>) {
  const events: { type: string; [key: string]: unknown }[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('OpenAICompatibleAdapter', () => {
  it('sends Authorization header and normalizes meta -> delta -> done', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchMock = async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"问题"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"出在"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\n',
        'data: [DONE]\n\n',
      ]);
    };
    const adapter = new OpenAICompatibleAdapter({ fetchFn: fetchMock });
    const events = await collect(adapter.stream(params(), 'deepseek'));

    expect(capturedUrl).toBe('https://api.example.com/v1/chat/completions');
    expect(capturedInit?.method).toBe('POST');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');

    expect(events.map((e) => e.type)).toEqual(['meta', 'delta', 'delta', 'done']);
    expect(events[1]).toEqual({ type: 'delta', text: '问题' });
    expect(events[2]).toEqual({ type: 'delta', text: '出在' });
    expect(events[3]).toMatchObject({ type: 'done', finishReason: 'stop', usage: { promptTokens: 12, completionTokens: 5 } });
  });

  it('normalizes upstream non-2xx to UPSTREAM_ERROR without leaking the key', async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ error: { message: 'invalid key provided' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    const adapter = new OpenAICompatibleAdapter({ fetchFn: fetchMock });
    await expect(collect(adapter.stream(params(), 'deepseek'))).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      status: 502,
    });

    // And the error message must not contain the api key.
    const adapter2 = new OpenAICompatibleAdapter({ fetchFn: fetchMock });
    try {
      await collect(adapter2.stream(params(), 'deepseek'));
      throw new Error('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(FAKE_KEY);
      expect(message).toContain('401');
    }
  });

  it('normalizes a never-resolving upstream to UPSTREAM_TIMEOUT with injectable timeout', async () => {
    const fetchMock = () => new Promise<Response>(() => {});
    const adapter = new OpenAICompatibleAdapter({ fetchFn: fetchMock, timeoutMs: 50 });
    await expect(collect(adapter.stream(params(), 'deepseek'))).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
      status: 504,
    });
  });

  it('handles non-streaming chat completions', async () => {
    const fetchMock = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '修复后的代码' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    const adapter = new OpenAICompatibleAdapter({ fetchFn: fetchMock });
    const result = await adapter.chat(params({ stream: false }));
    expect(result.content).toBe('修复后的代码');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 20 });
  });

  it('parses SSE frames split across chunk boundaries', async () => {
    const fetchMock = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"con',
        'tent":"拼接"}}]}\n\ndata: {"choices":[{"delta":{"content":"成功"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ]);
    const adapter = new OpenAICompatibleAdapter({ fetchFn: fetchMock });
    const events = await collect(adapter.stream(params(), 'deepseek'));
    expect(events.map((e) => e.type)).toEqual(['meta', 'delta', 'delta', 'done']);
    expect(events[1]).toEqual({ type: 'delta', text: '拼接' });
    expect(events[2]).toEqual({ type: 'delta', text: '成功' });
  });
});

describe('buildChatBody —— NVIDIA 兼容（supportsSystemRole=false）', () => {
  const sysMsg = { role: 'system' as const, content: 'SYS' };
  const baseMsgs = [
    sysMsg,
    { role: 'user' as const, content: 'hi' },
    { role: 'assistant' as const, content: 'hello' },
    { role: 'user' as const, content: 'again' },
  ];

  it('nvidia: 把 system 折叠进首条 user，请求体不含 system 角色', () => {
    const body = buildChatBody(params({ messages: baseMsgs }), {
      nativeTools: true,
      toolChoiceValues: ['auto'],
      contextWindow: 128000,
      retainReasoningContent: false,
      requireToolStreamFlag: false,
      explicitParallelToolCalls: false,
      supportsSystemRole: false,
    });
    const msgs = body.messages as Array<{ role: string; content: string }>;
    expect(msgs.some((m) => m.role === 'system')).toBe(false);
    // 首条 user 携带被折叠的 system 内容。
    expect(msgs[0]).toEqual({ role: 'user', content: 'SYS\n\nhi' });
    expect(msgs).toHaveLength(3);
  });

  it('nvidia: 无 user 消息时把 system 作为单条 user 发出', () => {
    const body = buildChatBody(params({ messages: [sysMsg] }), {
      nativeTools: true,
      toolChoiceValues: ['auto'],
      contextWindow: 128000,
      retainReasoningContent: false,
      requireToolStreamFlag: false,
      explicitParallelToolCalls: false,
      supportsSystemRole: false,
    });
    const msgs = body.messages as Array<{ role: string; content: string }>;
    expect(msgs).toEqual([{ role: 'user', content: 'SYS' }]);
  });

  it('默认（openai 等）：保留 system 角色，不做折叠', () => {
    const body = buildChatBody(params({ messages: baseMsgs }), {
      nativeTools: true,
      toolChoiceValues: ['auto'],
      contextWindow: 128000,
      retainReasoningContent: false,
      requireToolStreamFlag: false,
      explicitParallelToolCalls: false,
    });
    const msgs = body.messages as Array<{ role: string }>;
    expect(msgs[0].role).toBe('system');
    expect(msgs).toHaveLength(4);
  });
});

