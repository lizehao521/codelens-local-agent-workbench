// 首 token 空窗的回归测试：
// 1) SSE 分帧必须在 CRLF 下也逐帧产出（否则流式退化成「最后一次性出现」）
// 2) 流式期必须渲染「等待/思考」中间态（否则十几秒白屏被当成卡死）

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseAgentSSE } from '../src/services/stream';
import { AgentMessageItem } from '../src/components/agent/AgentMessageItem';
import { useRunStore } from '../src/stores/runStore';
import type { SessionMessageRow } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  // jsdom 没有 ReadableStream，用最小 reader 桩：只需 read() 逐块返回即可覆盖解析逻辑
  let i = 0;
  const stream = {
    getReader: () => ({
      read: async () =>
        i < chunks.length
          ? { done: false, value: encoder.encode(chunks[i++]) }
          : { done: true, value: undefined },
    }),
  } as unknown as ReadableStream<Uint8Array>;
  return { body: stream } as unknown as Response;
}

describe('parseAgentSSE —— 分帧健壮性', () => {
  it('CRLF 分帧 + 跨 chunk 的 \\r|\\n 边界，仍逐帧分发', async () => {
    const frames = [
      'event: reasoning\r\ndata: {"text":"先想"}\r\n\r\n',
      'event: delta\r\ndata: {"text":"再答"}\r\n\r\n',
      'event: done\r\ndata: {"reason":"stop"}\r\n\r\n',
    ];
    // 故意在第 1 帧的 \r 与 \n 之间切开
    const cut = 30;
    const raw = frames.join('');
    const seen: string[] = [];
    await parseAgentSSE(sseResponse([raw.slice(0, cut), raw.slice(cut)]), {
      onReasoning: (d) => seen.push(`reasoning:${d.text}`),
      onDelta: (d) => seen.push(`delta:${d.text}`),
      onDone: () => seen.push('done'),
    });
    expect(seen).toEqual(['reasoning:先想', 'delta:再答', 'done']);
  });

  it('R3：stage 帧按 connecting → upstream_first_byte → content → done 顺序分发', async () => {
    const payload = (stage: string, elapsedMs: number): string =>
      `event: stage\r\ndata: ${JSON.stringify({
        runId: 'run-1',
        stage,
        at: 1_000,
        elapsedMs,
        detail: null,
      })}\r\n\r\n`;
    const seen: string[] = [];
    await parseAgentSSE(
      sseResponse([
        payload('connecting', 0),
        payload('upstream_first_byte', 820),
        payload('content', 830),
        payload('done', 2_100),
      ]),
      {
        onStage: (d) => seen.push(`${d.stage}:${d.elapsedMs}`),
      },
    );
    expect(seen).toEqual(['connecting:0', 'upstream_first_byte:820', 'content:830', 'done:2100']);
  });
});

describe('AgentMessageItem —— 首 token 空窗的中间态', () => {
  let container: HTMLDivElement;
  let root: Root;

  const base: SessionMessageRow = {
    id: 'm1',
    seq: 1,
    role: 'assistant',
    content: '',
    segments: null,
    tokens: 0,
    isSummary: false,
    createdAt: 1,
    status: 'streaming',
  };

  beforeEach(() => {
    useRunStore.getState().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useRunStore.getState().reset();
  });

  function render(message: SessionMessageRow): string {
    act(() => root.render(createElement(AgentMessageItem, { message })));
    return container.textContent ?? '';
  }

  it('已有推理增量时显示「思考中…」与推理内容', () => {
    const text = render({ ...base, reasoningText: '先确认仓库结构，再决定改哪里' });
    expect(text).toContain('思考中');
    expect(text).toContain('先确认仓库结构');
  });

  it('还没有任何事件时显示「正在连接模型…」而不是纯空白', () => {
    const text = render({ ...base });
    expect(text).toContain('正在连接模型');
  });

  it('收到上游已响应阶段后，等待文案切到「模型已响应，正在生成…」', () => {
    act(() => {
      useRunStore.getState().applyStage({
        runId: 'r1',
        stage: 'upstream_first_byte',
        at: Date.now(),
        elapsedMs: 900,
        detail: null,
      });
    });
    const text = render({ ...base });
    expect(text).toContain('模型已响应，正在生成');
  });
});
