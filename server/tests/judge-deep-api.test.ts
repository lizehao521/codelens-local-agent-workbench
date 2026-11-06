/**
 * deep-judge 端点验收 —— 系统里第一个「写判决」的 HTTP 入口。
 *
 * 它比只读端点多承担三件事，每条都要有用例守住：
 *  1. client credentials 默认可用、可被运维关闭（关掉时必须 400 且不发请求）；
 *  2. 并发冲突用 409/429 表达（那确实需要客户端改行为），
 *     而「不可深判」用 200 + status=unexec 表达（那是有效结论，不是请求失败）；
 *  3. 响应体里永远不出现凭证原文。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { FakeLlm } from './fixtures/fake-llm.js';

let runtime: Runtime;
let fake: FakeLlm;
let server: http.Server;
let base: string;
let tmpRoot: string;
let sessionId: string;

const SECRET = 'sk-api-SECRET-999';

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'codelens-deep-api-'));
  runtime = createRuntime({ dbPath: path.join(tmpRoot, 'api.db') });
  const app = createApp({ runtime, autoStartModelSync: false });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake = await FakeLlm.start();

  sessionId = 'sess-api-1';
  const now = Date.now();
  runtime.db.run(
    `INSERT INTO sessions (id, title, provider, model, channel_mode, degraded, message_count, total_tokens, created_at, updated_at)
     VALUES (?, ?, 'custom', 'fake-model', 'auto', 0, 2, 0, ?, ?)`,
    [sessionId, '深判 API', now, now],
  );
  runtime.db.run(
    `INSERT INTO messages (id, session_id, seq, role, content, tokens, is_summary, created_at)
     VALUES ('a1', ?, 1, 'user', ?, 10, 0, ?)`,
    [sessionId, '把日志按天轮转并压缩', now],
  );
  runtime.db.run(
    `INSERT INTO messages (id, session_id, seq, role, content, tokens, is_summary, created_at)
     VALUES ('a2', ?, 2, 'assistant', ?, 20, 0, ?)`,
    [sessionId, '已完成：按天切割并 gzip 归档。', now],
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await fake.close();
  await runtime.close();
  delete process.env.JUDGE_DEEP_ALLOW_CLIENT_KEY;
  const dir = tmpRoot;
  setImmediate(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
    }
  });
});

function judgedRun(): number {
  const result = runtime.judge.judge(sessionId, {
    finishReason: 'stop',
    iteration: 2,
    tokenBudget: 200_000,
    usage: { promptTokens: 100, completionTokens: 50 },
    circuitOpened: false,
  });
  return result.runId!;
}

async function post(urlPath: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function creds() {
  return {
    provider: 'custom',
    model: 'fake-model',
    baseUrl: fake.baseUrl,
    credentials: { apiKey: SECRET },
  };
}

describe('POST /judge/runs/:id/deep-judge', () => {
  it('非法 id ⇒ 400；不存在的 run ⇒ 404', async () => {
    const bad = await post('/api/v1/judge/runs/abc/deep-judge', creds());
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_RUN_ID');

    const missing = await post('/api/v1/judge/runs/999999/deep-judge', creds());
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('JUDGE_RUN_NOT_FOUND');
  });

  it('成功深判 ⇒ 200，响应含 tier/parentRun/指纹，且不含凭证原文', async () => {
    const parent = judgedRun();
    fake.script([{ text: '{"verdict":"pass","score":0.9,"reasons":["ok"]}' }]);

    const res = await post(`/api/v1/judge/runs/${parent}/deep-judge`, creds());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.tier).toBe('deep');
    expect(res.body.parentRun).toBe(parent);
    expect(res.body.wroteRow).toBe(true);
    expect(res.body.deep.provider).toEqual({
      providerId: 'custom',
      model: 'fake-model',
      baseUrlHost: new URL(fake.baseUrl).host,
      keySource: 'client',
      modelSource: 'request',
    });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('运维关闭客户端凭证 ⇒ 400，且一次上游调用都不发', async () => {
    const parent = judgedRun();
    process.env.JUDGE_DEEP_ALLOW_CLIENT_KEY = '0';

    const res = await post(`/api/v1/judge/runs/${parent}/deep-judge`, creds());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('JUDGE_DEEP_CLIENT_KEY_NOT_ALLOWED');
    expect(fake.requests).toHaveLength(0);
    expect(runtime.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM judge_runs WHERE parent_run IS NOT NULL')!.n).toBe(0);
  });

  it('不可深判（无凭证）⇒ 200 + unexec，而不是 4xx', async () => {
    const parent = judgedRun();
    // 既不给 credentials，服务端也没有 LLM_SERVER_API_KEY
    const res = await post(`/api/v1/judge/runs/${parent}/deep-judge`, {
      provider: 'custom',
      model: 'fake-model',
      baseUrl: fake.baseUrl,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unexec');
    expect(res.body.failure).toBe('not_configured');
    expect(res.body.wroteRow).toBe(false);
  });

  it('GET /runs/:id 能看见原判决上的 latestDeep 指引', async () => {
    const parent = judgedRun();
    fake.script([{ text: '{"verdict":"fail","score":0.2,"reasons":["未涉及轮转"]}' }]);
    const deep = await post(`/api/v1/judge/runs/${parent}/deep-judge`, creds());
    expect(deep.status).toBe(200);

    const res = await fetch(`${base}/api/v1/judge/runs/${parent}`);
    const body = await res.json();
    expect(body.run.tier).toBe('rules');
    expect(body.run.latestDeep).toBeTruthy();
    expect(body.run.latestDeep.id).toBe(deep.body.runId);
    expect(body.run.latestDeep.model).toBe('fake-model');
    // 深判不改写原判决
    expect(body.run.verdict).not.toBe('fail');
  });
});
