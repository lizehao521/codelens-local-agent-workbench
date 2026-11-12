/**
 * RSI 出口一致性（2.11 收敛验收）。
 *
 * ── 这条判据守什么 ────────────────────────────────────────
 * 收敛前 RSI 有两套出口：`app.ts` 内联的 `/api/rsi/{overview,rules}`，和
 * `routes/rsi.routes.ts` 的 `/api/v1/rsi/*`。同一块功能对着两套前缀，
 * 前端 `api.ts` 里被迫写两遍兜底，而「两边都记得改」这种约定迟早会断。
 *
 * 收敛的做法不是删旧路径，而是**让两个出口共用同一个 controller 方法**，
 * 再各写一条转发。所以本文件的三条断言本质是同一件事的三个侧面：
 *   1. 同源 —— 两个出口的响应体深度相等（改造后不可能分叉，除非有人复制代码）；
 *   2. 同缓存口径 —— 都必须是 no-store，否则浏览器缓存会让它们在 HTTP 层分叉
 *      （这种分叉普通 curl 抓不到，只在浏览器里复现）；
 *   3. 同前缀 —— 前端源码里不许再出现旧字面量。这条是防回归的锁：
 *      代码可以改回去，但改回去这条会红。
 *
 * 第 3 条读的是源码文本而不是运行行为，因为它要抓的是「有人又把 URL 写回旧前缀」，
 * 这种错误在运行时是静默的（旧路径仍然可用）。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createRuntime, type Runtime } from '../../src/runtime.js';
import { resetRateLimits } from '../../src/middlewares/rate-limit.js';

const SESSION_ID = 'sess-rsi-exit-consistency-001';
const MISSING_SESSION = '00000000-0000-4000-8000-000000000000';

let runtime: Runtime;
let server: http.Server;
let base: string;
let tmpRoot: string;

beforeEach(async () => {
  resetRateLimits();
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'codelens-rsi-exit-'));
  runtime = createRuntime({ dbPath: path.join(tmpRoot, 'rsi-exit.db') });
  const app = createApp({ runtime, autoStartModelSync: false });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const now = Date.now();
  runtime.db.run(
    `INSERT INTO sessions (id, title, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [SESSION_ID, 'rsi-exit-consistency', 'custom', 'm', now, now],
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await runtime.close();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
  }
});

const getJson = async (url: string): Promise<{ status: number; cache: string | null; body: unknown }> => {
  const res = await fetch(`${base}${url}`);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON 就保留原文，交给断言报错 */
  }
  return { status: res.status, cache: res.headers.get('cache-control'), body };
};

describe('RSI 规则契约：/api/v1 与旧 /api 同源', () => {
  it('两个出口都是 200 / no-store / 响应体深度相等', async () => {
    const v1 = await getJson('/api/v1/rsi/rules');
    const legacy = await getJson('/api/rsi/rules');

    expect(v1.status).toBe(200);
    expect(legacy.status).toBe(200);
    expect(v1.cache).toBe('no-store');
    expect(legacy.cache).toBe('no-store');
    // 深度相等而不是字符串相等：键序不是契约的一部分，字段与取值才是。
    expect(v1.body).toEqual(legacy.body);
  });

  it('/api/v1/rsi/rules 与 /api/v1/rsi/contract 同体（同源不等于同缓存口径）', async () => {
    const rules = await getJson('/api/v1/rsi/rules');
    const contract = await getJson('/api/v1/rsi/contract');
    expect(rules.body).toEqual(contract.body);
  });
});

describe('RSI 看板读数：/api/v1 与旧 /api 同源', () => {
  it('会话不存在时两边都是 404，且错误体一致', async () => {
    const v1 = await getJson(`/api/v1/rsi/overview?session=${MISSING_SESSION}`);
    const legacy = await getJson(`/api/rsi/overview?session=${MISSING_SESSION}`);

    expect(v1.status).toBe(404);
    expect(legacy.status).toBe(404);
    expect(v1.body).toEqual(legacy.body);
  });

  it('缺 session 参数时两边都是 400，且错误体一致', async () => {
    const v1 = await getJson('/api/v1/rsi/overview');
    const legacy = await getJson('/api/rsi/overview');

    expect(v1.status).toBe(400);
    expect(legacy.status).toBe(400);
    expect(v1.body).toEqual(legacy.body);
  });

  it('会话存在时两边 200、no-store、读数深度相等且都带 rules', async () => {
    const v1 = await getJson(`/api/v1/rsi/overview?session=${SESSION_ID}`);
    const legacy = await getJson(`/api/rsi/overview?session=${SESSION_ID}`);

    expect(v1.status).toBe(200);
    expect(v1.cache).toBe('no-store');
    expect(v1.body).toEqual(legacy.body);

    const payload = v1.body as Record<string, unknown>;
    // 迁移不许改契约：这 7 个顶层字段是前端已经依赖的全部。
    expect(Object.keys(payload).sort()).toEqual(
      ['attributions', 'eval', 'judgeRuns', 'rsiRuns', 'rules', 'session', 'verdictsByRun'].sort(),
    );
  });
});

describe('前端已迁到 /api/v1（防回退）', () => {
  it('api.ts 里不再出现旧前缀字面量', () => {
    // 相对本文件定位仓库根：tests/contract → server → repo
    const apiPath = path.resolve(__dirname, '..', '..', '..', 'client', 'src', 'services', 'api.ts');
    const source = readFileSync(apiPath, 'utf8');

    expect(source).not.toContain('/api/rsi/');
    expect(source).toContain('/api/v1/rsi/overview');
    expect(source).toContain('/api/v1/rsi/rules');
  });
});
