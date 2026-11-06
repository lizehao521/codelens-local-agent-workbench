import { describe, expect, it, beforeEach, vi } from 'vitest';
import { setSyncedProviders, listProviders } from '../src/providers/registry.js';
import {
  ProviderModelRepository,
  ModelSyncLogRepository,
} from '../src/repositories/provider-model.repository.js';
import { ModelSyncService } from '../src/services/model-sync/model-sync.service.js';
import { ModelSourceSchema } from '../src/validators/model-source.schema.js';
import type { UrlVerdict } from '../src/utils/ssrf-guard.js';

function okVerdict(url = 'https://up.example/catalog.json'): UrlVerdict {
  return { ok: true, url: new URL(url), hostname: 'up.example', addresses: ['1.2.3.4'] };
}

function makeService(
  overrides: Partial<{
    sourceUrl: string;
    fetchImpl: typeof fetch;
    validateUrl: (u: string) => Promise<UrlVerdict>;
    format: 'native' | 'openai';
  }> = {},
) {
  const providerRepo = {
    replaceSnapshot: vi.fn(),
    getLatestSnapshot: vi.fn(() => []),
  } as unknown as ProviderModelRepository;
  const logRepo = {
    insert: vi.fn(),
    recent: vi.fn(() => []),
    status: vi.fn(() => ({
      lastRunAt: null, lastStatus: 'never' as const, lastError: null,
      lastProviderCount: null, lastModelCount: null, sourceUrl: overrides.sourceUrl ?? '',
    })),
  } as unknown as ModelSyncLogRepository;
  const config = {
    sourceUrl: overrides.sourceUrl ?? 'https://up.example/catalog.json',
    refreshIntervalMs: 0,
    retryMaxAttempts: 3,
    retryBackoffMs: 10,
    allowInsecure: false,
    format: overrides.format ?? 'native',
    timeoutMs: 1000,
    logFilePath: '',
  };
  const svc = new ModelSyncService(
    providerRepo,
    logRepo,
    config,
    overrides.fetchImpl ?? (async () => new Response('{}')),
    overrides.validateUrl ?? (async () => okVerdict(overrides.sourceUrl ?? 'https://up.example/catalog.json')),
  );
  return { svc, providerRepo, logRepo };
}

describe('ModelSyncService', () => {
  beforeEach(() => setSyncedProviders([]));

  it('ModelSourceSchema: 正常响应通过', () => {
    const ok = ModelSourceSchema.safeParse({
      providers: [{
        id: 'x', name: 'X', baseUrl: 'https://x/v1',
        models: [{ id: 'm', name: 'M', capabilities: { function_calling: true } }],
      }],
    });
    expect(ok.success).toBe(true);
  });

  it('ModelSourceSchema: 缺字段 / 重复 id / 多余字段被拒', () => {
    expect(ModelSourceSchema.safeParse({ providers: [{ id: 'x' }] }).success).toBe(false);
    expect(
      ModelSourceSchema.safeParse({
        providers: [{ id: 'x', name: 'X', baseUrl: 'https://x', models: [{ id: 'm' }, { id: 'm' }] }],
      }).success,
    ).toBe(false);
    expect(
      ModelSourceSchema.safeParse({
        providers: [{ id: 'x', name: 'X', baseUrl: 'https://x', extra: 1 }],
      }).success,
    ).toBe(false);
  });

  it('fetchOnce 成功后合并进 registry 并落快照 + 记 success 日志', async () => {
    const body = JSON.stringify({
      providers: [{
        id: 'newp', name: 'New', baseUrl: 'https://new/v1',
        models: [{ id: 'nm', name: 'NM' }],
      }],
    });
    const { svc, providerRepo, logRepo } = makeService({
      fetchImpl: async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await svc.fetchOnce();
    expect(listProviders().some((p) => p.id === 'newp')).toBe(true);
    expect(providerRepo.replaceSnapshot).toHaveBeenCalled();
    expect(logRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });

  it('fetchOnce SSRF 拒绝 → 记 error 日志且不抛、静态目录仍在', async () => {
    const { svc, logRepo } = makeService({
      validateUrl: async () => ({ ok: false, reason: 'DISALLOWED_IP', message: 'blocked' }),
    });
    await expect(svc.fetchOnce()).resolves.toBeUndefined();
    expect(logRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    expect(listProviders().length).toBeGreaterThan(0);
  });

  it('fetchOnce 连续失败至耗尽 → 记录 error 且不冒泡', async () => {
    const { svc, logRepo } = makeService({
      retryMaxAttempts: 3,
      retryBackoffMs: 1,
      fetchImpl: async () => {
        throw new Error('boom');
      },
    });
    await expect(svc.fetchOnce()).resolves.toBeUndefined();
    expect(logRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('sourceUrl 为空 → disabled 且保留静态目录', async () => {
    const { svc, logRepo } = makeService({ sourceUrl: '' });
    await svc.fetchOnce();
    expect(logRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'disabled' }));
    expect(listProviders().length).toBeGreaterThan(0);
  });

  it('fetchOnce 接受 OpenAI 兼容 /v1/models 并适配为目录', async () => {
    const body = JSON.stringify({
      object: 'list',
      data: [{ id: 'deepseek-chat' }, { id: 'gpt-4o' }],
    });
    const { svc, logRepo } = makeService({
      sourceUrl: 'http://121.36.29.96:8787/v1/models',
      fetchImpl: async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await svc.fetchOnce();
    const demo = listProviders().find((p) => p.id === 'openai-compatible');
    expect(demo).toBeTruthy();
    if (demo) {
      expect(demo.baseUrl).toBe('http://121.36.29.96:8787/v1');
      expect(demo.models.map((m) => m.id)).toEqual(['deepseek-chat', 'gpt-4o']);
    }
    expect(logRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });

  it('MODEL_SOURCE_FORMAT=openai 显式走适配器', async () => {
    const body = JSON.stringify({ object: 'list', data: [{ id: 'gpt-4o-mini' }] });
    const { svc, logRepo } = makeService({
      sourceUrl: 'http://x/v1/models',
      format: 'openai',
      fetchImpl: async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await svc.fetchOnce();
    const demo = listProviders().find((p) => p.id === 'openai-compatible');
    expect(demo).toBeTruthy();
    if (demo) expect(demo.models.map((m) => m.id)).toEqual(['gpt-4o-mini']);
    expect(logRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });
});
