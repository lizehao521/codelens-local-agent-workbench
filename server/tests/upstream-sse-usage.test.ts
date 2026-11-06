/**
 * P0-1 — upstream SSE usage recovery on mid-stream failures.
 *
 * The agent loop used to accumulate `usage` only from a turn's final `done`
 * event. When the upstream connection broke mid-stream (or the run was
 * aborted), the post-loop `done` never fired and the tokens the provider had
 * already billed — the prompt plus any completion tokens that arrived — were
 * silently dropped from `done.usage`. parseUpstreamSSE now attaches the
 * accumulated usage to the escaping error so the loop can account for it.
 */

import { describe, expect, it } from 'vitest';
import { parseUpstreamSSE } from '../src/providers/openai-compatible.adapter.js';
import type { UpstreamEvent } from '../src/types/index.js';

interface UsageLike {
  promptTokens: number;
  completionTokens: number;
}

function streamFrom(chunks: string[], options: { errorAfter?: Error } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]!));
        index += 1;
        return;
      }
      if (options.errorAfter) controller.error(options.errorAfter);
      else controller.close();
    },
  });
}

const USAGE_CHUNK =
  'data: ' +
  JSON.stringify({
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' } }],
    usage: { prompt_tokens: 777, completion_tokens: 33, total_tokens: 810 },
  }) +
  '\n\n';

async function drain(stream: ReadableStream<Uint8Array>): Promise<{ events: UpstreamEvent[]; error: unknown }> {
  const events: UpstreamEvent[] = [];
  let error: unknown;
  try {
    for await (const event of parseUpstreamSSE(stream)) events.push(event);
  } catch (err) {
    error = err;
  }
  return { events, error };
}

describe('parseUpstreamSSE usage handling (P0-1)', () => {
  it('emits done with usage on a normal [DONE] ending', async () => {
    const { events, error } = await drain(
      streamFrom([USAGE_CHUNK, 'data: [DONE]\n\n']),
    );
    expect(error).toBeUndefined();
    const done = events.find((event) => event.type === 'done');
    expect(done?.type === 'done' && done.usage).toEqual({ promptTokens: 777, completionTokens: 33 });
    expect(events.some((event) => event.type === 'delta')).toBe(true);
  });

  it('emits done with usage on an abnormal ending (no [DONE])', async () => {
    const { events, error } = await drain(streamFrom([USAGE_CHUNK]));
    expect(error).toBeUndefined();
    const done = events.find((event) => event.type === 'done');
    expect(done?.type === 'done' && done.usage).toEqual({ promptTokens: 777, completionTokens: 33 });
  });

  it('attaches the accumulated usage to the error when the stream breaks mid-flight', async () => {
    const { events, error } = await drain(
      streamFrom([USAGE_CHUNK], { errorAfter: new Error('socket hang up') }),
    );
    // The break surfaces as a throw (the loop decides abort vs. error)…
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('socket hang up');
    // …but the billed tokens ride along instead of vanishing.
    expect((error as { partialUsage?: UsageLike }).partialUsage).toEqual({
      promptTokens: 777,
      completionTokens: 33,
    });
    // No done event was emitted on this path (the error replaces it).
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(events.some((event) => event.type === 'delta')).toBe(true);
  });

  it('does not attach partialUsage when nothing was billed yet', async () => {
    const { error } = await drain(streamFrom([], { errorAfter: new Error('ECONNRESET') }));
    expect(error).toBeInstanceOf(Error);
    expect((error as { partialUsage?: UsageLike }).partialUsage).toBeUndefined();
  });

  it('keeps the latest usage values when a later chunk overwrites them', async () => {
    const later =
      'data: ' +
      JSON.stringify({
        choices: [{ index: 0, delta: {} }],
        usage: { prompt_tokens: 900, completion_tokens: 44, total_tokens: 944 },
      }) +
      '\n\n';
    const { error } = await drain(streamFrom([USAGE_CHUNK, later], { errorAfter: new Error('boom') }));
    expect((error as { partialUsage?: UsageLike }).partialUsage).toEqual({
      promptTokens: 900,
      completionTokens: 44,
    });
  });
});
