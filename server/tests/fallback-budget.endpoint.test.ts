import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

describe('GET /api/v1/agent/trial-status（A-02 接线）', () => {
  let runtime: Runtime;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'codelens-trial-'));
    runtime = createRuntime({ dbPath: path.join(tmpRoot, 'trial.db') });
  });

  afterEach(async () => {
    await runtime.close();
    // 宿主环境的删除守卫（safe-delete shim）可能在并发下超时。
    // 清理是 best-effort：残留目录由环境侧回收，但不能让它把已通过的用例判红。
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch (err) {
      console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
    }
  });

  it('默认（试用关闭、无兜底 Key）返回 200 + enabled=false', async () => {
    const app = createApp({ runtime, autoStartModelSync: false });
    const res = await request(app).get('/api/v1/agent/trial-status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: false,
      serverKeyConfigured: false,
      dailyLimit: null,
      usedRuns: 0,
      remainingRuns: null,
      budgetExceeded: false,
    });
  });

  it('路由确实挂载在 agent 命名空间下，且不接受 POST 触发副作用', async () => {
    const app = createApp({ runtime, autoStartModelSync: false });
    const res = await request(app).post('/api/v1/agent/trial-status');
    // 未定义 POST → 405（NotAllowed）或 404，总之不允许写副作用。
    expect([404, 405]).toContain(res.status);
  });
});