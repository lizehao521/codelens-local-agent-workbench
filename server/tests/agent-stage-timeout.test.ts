// R3 回归：上游超时与上游错误的阶段终局必须可区分（不能都落进同一个 catch）。
// 通过 createRuntime 注入 1s 上游超时，避免依赖进程环境变量或动态导入。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { FakeLlm, type SseEvent } from './fixtures/fake-llm.js';
import { runAgentStream } from './fixtures/agent-http.js';

let fake: FakeLlm;
let runtime: Runtime;
let server: http.Server | undefined;
let base: string;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'codelens-stage-timeout-'));
  runtime = createRuntime({
    dbPath: path.join(tmpRoot, 'timeout.db'),
    upstreamTimeoutMs: 1000,
    upstreamMaxRetries: 0,
  });
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

describe('R3 阶段终局区分', () => {
  it(
    '上游 1s 内不回响应头 → stage upstream_timeout + error UPSTREAM_TIMEOUT（而不是笼统 error）',
    { timeout: 30_000 },
    async () => {
      fake.script([{ stall: true }]);
      const events: SseEvent[] = [];
      const { status } = await runAgentStream(
        base,
        {
          provider: 'custom',
          customBaseUrl: fake.baseUrl,
          model: 'fake-model-1',
          apiKey: 'test-key-stage',
          message: '触发超时',
          channelMode: 'auto',
          tools: [],
          maxIterations: 5,
          temperature: 0.2,
          maxTokens: 256,
        },
        (event) => {
          events.push(event);
        },
      );

      expect(status).toBe(200);
      const timeoutStage = events.find((e) => e.name === 'stage' && e.data.stage === 'upstream_timeout');
      expect(timeoutStage).toBeDefined();
      expect(timeoutStage!.data.elapsedMs).toBeGreaterThanOrEqual(900);
      expect(timeoutStage!.data.detail).toContain('超时');
      // 超时终局不再发 done：前端以 error 事件 + 阶段终局收尾。
      expect(events.some((e) => e.name === 'stage' && e.data.stage === 'done')).toBe(false);
      expect(events.find((e) => e.name === 'error')?.data.code).toBe('UPSTREAM_TIMEOUT');
    },
  );
});
