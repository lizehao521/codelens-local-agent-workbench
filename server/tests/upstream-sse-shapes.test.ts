/**
 * 上游 SSE 形状兼容性的自证判据。
 *
 * 实测（2026-11-12，Cloudflare Workers AI /ai/v1）：一次提议轮里
 * `usage.completionTokens=94`、`finishReason=stop`，但 SSE 里**一条 delta 都没有**，
 * `firstTokenMs=null`。服务端把 94 个已计费的 token 整段丢了，
 * 还因为「不是 0 token」没触发 UPSTREAM_EMPTY，静默按正常结束收工。
 *
 * 根因是适配器只认 `choices[0].delta`。这套判据钉住两件事：
 *   · `choices[0].message` 形状（非流式/混合响应）也必须能取出正文与工具调用；
 *   · 标准 delta 形状不受影响（回归保护）。
 */

import { describe, expect, it } from 'vitest';
import { parseUpstreamSSE } from '../src/providers/openai-compatible.adapter.js';
import type { UpstreamEvent } from '../src/types/index.js';

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]!));
      else controller.close();
    },
  });
}

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

async function collect(chunks: string[]): Promise<UpstreamEvent[]> {
  const events: UpstreamEvent[] = [];
  for await (const e of parseUpstreamSSE(streamFrom(chunks))) events.push(e);
  return events;
}

describe('上游 SSE 形状兼容', () => {
  it('金丝雀：choices[0].message.content 也必须产出 delta（不再静默丢正文）', async () => {
    const events = await collect([
      sse({
        choices: [{ index: 0, message: { role: 'assistant', content: '{"id":"x"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 94 },
      }),
      'data: [DONE]\n\n',
    ]);
    const delta = events.find((e) => e.type === 'delta');
    expect(delta).toBeTruthy();
    expect(delta?.type === 'delta' ? delta.text : '').toBe('{"id":"x"}');
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('message 形状里的 tool_calls 也要被累积并发出', async () => {
    const events = await collect([
      sse({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      'data: [DONE]\n\n',
    ]);
    const tc = events.find((e) => e.type === 'tool_calls');
    expect(tc).toBeTruthy();
    // finalize 输出的是归一化后的 `name`（不是 OpenAI 线格式里的 function.name）。
    expect(tc?.type === 'tool_calls' ? tc.calls[0]?.name : '').toBe('read_file');
  });

  it('回归：标准 delta 形状不变', async () => {
    const events = await collect([
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'hel' } }] }),
      sse({ choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]);
    const text = events
      .filter((e): e is Extract<UpstreamEvent, { type: 'delta' }> => e.type === 'delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('hello');
  });

  it('只有 usage、确实没有正文时，不应该凭空造出 delta', async () => {
    const events = await collect([
      sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 94 } }),
      'data: [DONE]\n\n',
    ]);
    expect(events.some((e) => e.type === 'delta')).toBe(false);
    const done = events.find((e) => e.type === 'done');
    expect(done?.type === 'done' ? done.usage.completionTokens : 0).toBe(94);
  });
});
