/**
 * Agent HTTP 客户端夹具：SSE 事件流读取 + JSON 提交。
 *
 * 从 agent-loop-e2e.test.ts 抽出，供 e2e 与闭环演练（closure-drill）共用。
 * 抽出的理由不是「少写几行」，而是这两处断言的语义必须一致：
 * 如果演练用的流解析与 e2e 不同，一次「e2e 过、演练挂」的差异就无从归因。
 */

import type { SseEvent } from './fake-llm.js';

export async function runAgentStream(
  base: string,
  body: Record<string, unknown>,
  onEvent: (event: SseEvent) => Promise<void> | void,
  stopAfter: string[] = ['done', 'error'],
): Promise<{ status: number; events: SseEvent[] }> {
  const res = await fetch(`${base}/api/v1/agent/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf('\n\n');
    while (sep >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      sep = buffer.indexOf('\n\n');
      const name = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim();
      const dataLine = /^data:\s*(.+)$/m.exec(block)?.[1];
      if (!name || dataLine === undefined) continue; // heartbeat / comment frame
      let data: any = {};
      try {
        data = JSON.parse(dataLine);
      } catch {
        /* malformed frame: keep empty payload */
      }
      const event: SseEvent = { name, data };
      events.push(event);
      await onEvent(event);
      if (stopAfter.includes(name)) {
        void reader.cancel().catch(() => {});
        return { status: res.status, events };
      }
    }
  }
  return { status: res.status, events };
}

export async function postJson(base: string, urlPath: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
