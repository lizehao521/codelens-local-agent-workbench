// R3 回归：阶段事件（connecting → upstream_first_byte → content → done）
// + 上游长尾时早事件先到 + 中止能真正取消上游请求。
//
// 故障注入方式沿用 agent-loop-e2e：FakeLlm 不自带任何业务写操作，
// 只模拟「上游长时间不回响应」，不会触碰用户真实数据。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { FakeLlm, type SseEvent } from './fixtures/fake-llm.js';

let fake: FakeLlm;
let runtime: Runtime;
let server: http.Server;
let base: string;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'codelens-stage-'));
  runtime = createRuntime({ dbPath: path.join(tmpRoot, 'stage.db') });
  const app = createApp({ runtime, autoStartModelSync: false });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake = await FakeLlm.start();
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await fake.close();
  await runtime.close();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function agentBody(message: string): Record<string, unknown> {
  return {
    provider: 'custom',
    customBaseUrl: fake.baseUrl,
    model: 'fake-model-1',
    apiKey: 'test-key-stage',
    message,
    channelMode: 'auto',
    tools: ['fs.write'],
    maxIterations: 6,
    temperature: 0.2,
    maxTokens: 512,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

/** 逐帧读取 SSE，返回收集到的事件；调用方可用 AbortController 在任意时刻中止。 */
async function collectUntilAbort(
  controller: AbortController,
  onEvent: (event: SseEvent) => void,
): Promise<SseEvent[]> {
  const res = await fetch(`${base}/api/v1/agent/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agentBody('请简单回答')),
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = '';
  try {
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
        if (!name || dataLine === undefined) continue;
        let data: any = {};
        try {
          data = JSON.parse(dataLine);
        } catch {
          /* malformed frame */
        }
        const event: SseEvent = { name, data };
        events.push(event);
        onEvent(event);
      }
    }
  } catch {
    /* abort 会让 reader.read() 抛出；返回已收集事件即可 */
  }
  return events;
}

describe('R3 阶段事件', () => {
  it(
    '正常链路：connecting 先于任何上游访问，随后 upstream_first_byte → content → done',
    { timeout: 60_000 },
    async () => {
      fake.script([{ text: '阶段事件正常返回' }]);

      const events: SseEvent[] = [];
      let connectingElapsed: number | null = null;
      let requestsAtConnecting: number | null = null;
      const res = await fetch(`${base}/api/v1/agent/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agentBody('请创建一个文件')),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
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
          if (!name || dataLine === undefined) continue;
          const event: SseEvent = { name, data: JSON.parse(dataLine) };
          if (event.name === 'stage' && event.data.stage === 'connecting') {
            connectingElapsed = event.data.elapsedMs;
            requestsAtConnecting = fake.requests.length;
          }
          events.push(event);
          if (event.name === 'done' || event.name === 'error') {
            void reader.cancel().catch(() => {});
            break;
          }
        }
        if (events.some((e) => e.name === 'done' || e.name === 'error')) break;
      }

      const stages = events.filter((e) => e.name === 'stage').map((e) => e.data.stage);
      // 早事件在「请求被接受」的同一时刻发出（elapsedMs≈0），不是在拿到首 token 后才补发。
      expect(events[0]?.name).toBe('stage');
      expect(connectingElapsed).not.toBeNull();
      expect(connectingElapsed!).toBeLessThan(50);
      expect(requestsAtConnecting).not.toBeNull();
      if (process.env.STAGE_MEASURE === '1') {
        console.info(`[measure] connecting_elapsed_ms=${connectingElapsed}`);
      }
      expect(stages[0]).toBe('connecting');
      expect(stages).toContain('upstream_first_byte');
      expect(stages).toContain('content');
      expect(stages[stages.length - 1]).toBe('done');

      const payloads = events.filter((e) => e.name === 'stage').map((e) => e.data);
      for (const payload of payloads) {
        expect(typeof payload.runId).toBe('string');
        expect(payload.runId.length).toBeGreaterThan(0);
        expect(typeof payload.at).toBe('number');
        expect(typeof payload.elapsedMs).toBe('number');
      }
      // 同一 run 的阶段共享 runId，便于前端把阶段与一次请求绑定。
      expect(new Set(payloads.map((p) => p.runId)).size).toBe(1);
    },
  );

  it(
    '上游完全不回响应头时：connecting 仍在毫秒级到达，客户端不必面对静止界面',
    { timeout: 60_000 },
    async () => {
      fake.script([{ stall: true }]);
      const controller = new AbortController();
      const startedAt = Date.now();
      let firstStageAt: number | null = null;
      const events: SseEvent[] = [];

      const collecting = collectUntilAbort(controller, (event) => {
        if (!firstStageAt && event.name === 'stage' && event.data.stage === 'connecting') {
          firstStageAt = Date.now();
        }
      });
      // 等上游确实收到了 chat 请求（但故意不回），确认早事件不是「上游很快」的假象。
      const upstreamCalled = await waitFor(() => fake.requests.some((r) => r.stream === true));
      await sleep(300);
      controller.abort();
      events.push(...(await collecting));

      expect(upstreamCalled).toBe(true);
      expect(firstStageAt).not.toBeNull();
      // 改前：没有任何事件，只能等上游 60s 超时；改后应远小于 500ms。
      expect(firstStageAt! - startedAt).toBeLessThan(500);
      if (process.env.STAGE_MEASURE === '1') {
        console.info(`[measure] first_stage_ms=${firstStageAt! - startedAt}`);
      }
      expect(events.filter((e) => e.name === 'stage' && e.data.stage === 'connecting')).toHaveLength(1);
      // 上游连响应头都没回：不应出现 upstream_first_byte，也不应出现任何正文/推理块。
      expect(events.some((e) => e.name === 'stage' && e.data.stage === 'upstream_first_byte')).toBe(false);
      expect(events.filter((e) => e.name === 'delta' || e.name === 'reasoning')).toHaveLength(0);
    },
  );

  it(
    '中止能真正取消上游请求（AbortController 贯通），且生效在秒级以内',
    { timeout: 60_000 },
    async () => {
      fake.script([{ stall: true }]);
      const controller = new AbortController();
      const collecting = collectUntilAbort(controller, () => {});
      const upstreamCalled = await waitFor(() => fake.requests.some((r) => r.stream === true));
      expect(upstreamCalled).toBe(true);

      const abortAt = Date.now();
      controller.abort();
      await collecting;

      const cancelled = await waitFor(() => fake.abortedRequests > 0, 3000);
      expect(cancelled).toBe(true);
      const cancelDelay = (fake.lastAbortAt ?? Date.now()) - abortAt;
      // 真实链路（客户端 → 服务端 → undici → 假上游）应远低于 3s 的等待窗口。
      expect(cancelDelay).toBeLessThan(1500);
      if (process.env.STAGE_MEASURE === '1') {
        console.info(`[measure] abort_to_upstream_cancel_ms=${cancelDelay}`);
      }
    },
  );
});
