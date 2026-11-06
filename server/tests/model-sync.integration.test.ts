import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

process.env.NODE_ENV = 'test';

const okValidate = async () => ({
  ok: true,
  url: new URL('https://up.example/catalog.json'),
  hostname: 'up.example',
  addresses: ['1.2.3.4'],
});

const successFetch = async () =>
  new Response(
    JSON.stringify({
      providers: [
        { id: 'synced', name: 'Synced', baseUrl: 'https://synced/v1', models: [{ id: 's1', name: 'S1' }] },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const failingFetch = async () => {
  throw new Error('network down');
};

async function buildApp(env: Record<string, string>, fetchImpl: typeof fetch, appOptions: Record<string, unknown> = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  const { createRuntime } = await import('../src/runtime.js');
  const { createApp } = await import('../src/app.js');
  const { setSyncedProviders } = await import('../src/providers/registry.js');
  setSyncedProviders([]);
  const runtime = createRuntime({ dbPath: ':memory:', fetchImpl, validateUrl: okValidate });
  const app = createApp({ runtime, ...appOptions });
  return { runtime, app };
}

describe('upstream model sync integration', () => {
  beforeAll(() => {
    process.env.MODEL_SOURCE_URL = 'https://upstream.test/catalog.json';
  });

  // 显式超时：这条要用真实 DNS 去解析不存在的 upstream.test，解析失败耗时随环境
  // 波动（本机实测单跑 7.4s）。靠默认 5s 能过只是碰巧，并发时会直接超时失败。
  it('GET /api/v1/providers 反映同步模型；/sync-status 反映成功', { timeout: 60_000 }, async () => {
    const { runtime, app } = await buildApp(
      { MODEL_SOURCE_URL: 'https://upstream.test/catalog.json' },
      successFetch,
    );
    await runtime.modelSync.fetchOnce();

    const provRes = await request(app).get('/api/v1/providers');
    expect(provRes.status).toBe(200);
    expect(provRes.body.providers.some((p: { id: string }) => p.id === 'synced')).toBe(true);

    const statusRes = await request(app).get('/api/v1/providers/sync-status');
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.sync.lastStatus).toBe('success');
    expect(statusRes.body.sync.lastProviderCount).toBe(1);
    expect(statusRes.body.sync.lastModelCount).toBe(1);

    await runtime.close();
  });

  it('错误上游 → 记日志且不崩；静态目录仍可用', async () => {
    const { runtime, app } = await buildApp(
      { MODEL_SOURCE_URL: 'https://upstream.test/catalog.json' },
      failingFetch,
    );
    await expect(runtime.modelSync.fetchOnce()).resolves.toBeUndefined();

    const provRes = await request(app).get('/api/v1/providers');
    expect(provRes.status).toBe(200);
    expect(provRes.body.providers.length).toBeGreaterThanOrEqual(6);

    const statusRes = await request(app).get('/api/v1/providers/sync-status');
    expect(statusRes.body.sync.lastStatus).toBe('error');

    await runtime.close();
  });

  it('MODEL_SOURCE_URL 为空 → disabled 且静态目录可用', async () => {
    const { runtime, app } = await buildApp({ MODEL_SOURCE_URL: '' }, successFetch);
    await runtime.modelSync.fetchOnce();

    const provRes = await request(app).get('/api/v1/providers');
    expect(provRes.body.providers.length).toBeGreaterThanOrEqual(6);

    const statusRes = await request(app).get('/api/v1/providers/sync-status');
    expect(statusRes.body.sync.lastStatus).toBe('disabled');

    await runtime.close();
  });

  it('默认（test 环境）createApp 不自动启动同步：未手动拉取前 lastStatus 为 never', async () => {
    const { runtime, app } = await buildApp(
      { MODEL_SOURCE_URL: 'https://upstream.test/catalog.json', MODEL_SOURCE_FORMAT: 'native' },
      successFetch,
    );
    // 给（若有）错误的自动启动一点时间；一旦发生应已变为 success/error，而非 never。
    await new Promise((r) => setTimeout(r, 120));
    const statusRes = await request(app).get('/api/v1/providers/sync-status');
    expect(statusRes.body.sync.lastStatus).toBe('never');
    await runtime.close();
  });

  it('createApp(autoStartModelSync:true) 自动启动同步（修复桌面嵌入态不拉取模型）', async () => {
    const { runtime, app } = await buildApp(
      { MODEL_SOURCE_URL: 'https://upstream.test/catalog.json', MODEL_SOURCE_FORMAT: 'native' },
      successFetch,
      { autoStartModelSync: true },
    );
    // 轮询等待自动拉取完成（首次成功，无退避）
    let lastStatus = 'never';
    for (let i = 0; i < 40 && lastStatus !== 'success'; i++) {
      const res = await request(app).get('/api/v1/providers/sync-status');
      lastStatus = res.body.sync.lastStatus;
      if (lastStatus !== 'success') await new Promise((r) => setTimeout(r, 25));
    }
    expect(lastStatus).toBe('success');

    const provRes = await request(app).get('/api/v1/providers');
    expect(provRes.body.providers.some((p: { id: string }) => p.id === 'synced')).toBe(true);
    await runtime.close();
  });
}, 30000);
