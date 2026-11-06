/**
 * tool-calling 能力探测的回归测试。
 *
 * 为什么单独测这个：2026-11-02 用真实端点跑端到端时发现，一个明确支持 tools 的
 * 模型被探测判成「不支持 function calling」，导致降级到 ReAct 通道、12 次工具调用
 * 全部失败。根因是两个写死的探测参数：
 *
 *   1. `tool_choice: 'auto'` —— 模型「可以调但选择不调」也会被当成不支持。
 *   2. `maxTokens: 16` —— 推理型模型把预算全花在思维链上（reasoning_tokens 单独计费
 *      但与 completion 共享上限），还没输出 tool_calls 就被 finish_reason:'length' 截断。
 *
 * 这两个参数是这个 bug 的全部成因，所以用例直接断言请求体，而不只断言返回值——
 * 只测返回值的话，把参数改回 'auto'/16 仍可能在某些响应下「碰巧通过」。
 *
 * 第三类问题是语义：被 max_tokens 截断属于「没测出来」，必须报 failed，
 * 不能报 unsupported —— 后者会在 provider_capabilities 里留下一个错误的否定结论，
 * 而且会被缓存（channel-router 只缓存 supported/unsupported），修代码也甩不掉。
 */

import { describe, expect, it } from 'vitest';
import { OpenAICompatibleAdapter, type ChatParams } from '../src/providers/openai-compatible.adapter.js';

const PARAMS: ChatParams = {
  baseUrl: 'https://up.example.com/v1',
  apiKey: 'sk-test-key',
  model: 'probe-model',
  messages: [{ role: 'user', content: 'ping' }],
  temperature: 0,
  maxTokens: 16,
  stream: false,
};

interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
}

/** 构造一个可捕获请求体的 adapter；handler 决定上游怎么回。 */
function makeAdapter(handler: (call: RecordedCall, index: number) => Response) {
  const calls: RecordedCall[] = [];
  const adapter = new OpenAICompatibleAdapter({
    fetchFn: async (url, init) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      const recorded: RecordedCall = { url: String(url), body: JSON.parse(raw) as Record<string, unknown> };
      calls.push(recorded);
      return handler(recorded, calls.length - 1);
    },
  });
  return { adapter, calls };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('probeToolSupport —— 探测参数（这个 bug 的成因）', () => {
  it('第一次探测用 tool_choice=required，而不是 auto', async () => {
    const { adapter, calls } = makeAdapter(() =>
      jsonResponse({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1' }] } }] }),
    );
    await adapter.probeToolSupport(PARAMS);

    expect(calls).toHaveLength(1);
    // auto 下模型可以不调，于是「支持 tools 但这次没调」被误判成「不支持」。
    expect(calls[0]!.body.tool_choice).toBe('required');
  });

  it('探测预算足够容下思维链，不是 16', async () => {
    const { adapter, calls } = makeAdapter(() =>
      jsonResponse({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1' }] } }] }),
    );
    await adapter.probeToolSupport(PARAMS);

    // 推理型模型会在输出 tool_calls 之前先写 reasoning，16 token 直接被吃光。
    const maxTokens = Number(calls[0]!.body.max_tokens);
    expect(maxTokens).toBeGreaterThanOrEqual(128);
  });
});

describe('probeToolSupport —— 三种判定', () => {
  it('拿到 tool_calls ⇒ supported', async () => {
    const { adapter } = makeAdapter(() =>
      jsonResponse({ choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 'c1' }] } }] }),
    );
    expect(await adapter.probeToolSupport(PARAMS)).toEqual({
      status: 'supported',
      evidence: 'tool_calls_returned',
    });
  });

  it('被 max_tokens 截断且没有 tool_calls ⇒ failed/probe_truncated（不是 unsupported）', async () => {
    const { adapter } = makeAdapter(() =>
      jsonResponse({
        choices: [
          {
            finish_reason: 'length',
            message: { content: '', reasoning_content: 'thinking hard…', tool_calls: null },
          },
        ],
        usage: { reasoning_tokens: 192 },
      }),
    );
    const outcome = await adapter.probeToolSupport(PARAMS);

    // 关键：这是「没测出来」，不是「测出来不支持」。
    // 判成 unsupported 会写进 provider_capabilities 并被 channel-router 缓存，
    // 之后即使修好探测逻辑也要手工清库才能恢复。
    expect(outcome.status).toBe('failed');
    expect(outcome).toMatchObject({ evidence: 'probe_truncated' });
  });

  it('正常结束但没有 tool_calls ⇒ unsupported（模型确实没调工具）', async () => {
    const { adapter } = makeAdapter(() =>
      jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '我不需要调用任何工具', tool_calls: null } }] }),
    );
    expect(await adapter.probeToolSupport(PARAMS)).toEqual({
      status: 'unsupported',
      evidence: 'text_response',
    });
  });
});

describe('probeToolSupport —— provider 不接受 required 时回退', () => {
  it('400 且错误提到 tool_choice ⇒ 回退 auto 重试一次', async () => {
    const { adapter, calls } = makeAdapter((call, index) => {
      if (index === 0) return jsonResponse({ error: { message: 'unsupported value for tool_choice' } }, 400);
      return jsonResponse({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1' }] } }] });
    });

    const outcome = await adapter.probeToolSupport(PARAMS);

    expect(outcome.status).toBe('supported');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.tool_choice).toBe('required');
    expect(calls[1]!.body.tool_choice).toBe('auto');
  });

  it('400 且错误提到 tools ⇒ 直接判 unsupported，不做重试', async () => {
    const { adapter, calls } = makeAdapter(() => jsonResponse({ error: { message: 'tools is not supported by this model' } }, 400));

    const outcome = await adapter.probeToolSupport(PARAMS);

    expect(outcome).toEqual({ status: 'unsupported', evidence: 'tools_param_rejected' });
    // 明确拒绝 tools 时重试是浪费，只允许一次请求。
    expect(calls).toHaveLength(1);
  });

  it('401 ⇒ failed/auth（不重试、不误判成能力问题）', async () => {
    const { adapter, calls } = makeAdapter(() => jsonResponse({ error: 'unauthorized' }, 401));

    const outcome = await adapter.probeToolSupport(PARAMS);

    expect(outcome).toMatchObject({ status: 'failed', evidence: 'auth' });
    expect(calls).toHaveLength(1);
  });
});
