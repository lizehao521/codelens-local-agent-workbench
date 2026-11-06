# 实现计划：自动获取上游模型（Upstream Model Sync）
日期：2026-10-23 ｜ 状态：已实现并验证（typecheck + 单测/集成测试全绿） ｜ 分支：feature/upstream-model-sync

> 设计草案见同目录 `2026-10-23-upstream-model-sync-design.md`（不要覆盖）。

## 0. 关键事实（来自代码勘察）
- 入口数据流：desktop/main.cjs 在 `require('./server-bundle.cjs')` 之前注入 process.env → server/src/config/env.ts 顶层读取 env 生成单例 config → createRuntime() 装配 → createApp() 组装路由。
- isMainModule 判定在 server/src/app.ts（不是 runtime.ts）。因此「启动即 fetchOnce + start」应在 app.ts 的 isMainModule 分支触发，createRuntime 仅负责装配 service 并暴露 runtime.modelSync。
- createApp 当前：`const runtime = options.runtime ?? createRuntime();`。测试可传入自建 runtime。
- 数据库迁移机制 = 启动即 `db.exec(SCHEMA_SQL)`（CREATE TABLE IF NOT EXISTS）。新增两张表直接加进 server/src/repositories/schema.ts 的 SCHEMA_SQL 即可（与 provider_capabilities 同模式）。schema_migrations 表存在但代码从不 bump 版本号——属既有遗留，本期沿用 IF NOT EXISTS DDL。
- 测试运行器：vitest（server/package.json：`"test": "vitest run"`、`"typecheck": "tsc --noEmit"`）。既有用例 server/tests/adapter.test.ts 用 `import ... from '../src/.../x.js'`（.js 指向 .ts，vitest 自动解析）。集成测试可用 supertest（已在 devDependencies）。
- 工作台非 git 仓库：baseline 任务需先 `git init` 并提交基线，再切分支（如不可用，则跳过 git，仅跑基线 typecheck/测试）。

## 1. 任务总览（13 个 Phase-3 任务，2–5 分钟粒度）
1. Baseline：git init + 分支 + typecheck + 现有测试绿灯
2. env 配置：新增 5 个键到 env.ts + .env.example
3. DB schema + 仓储：SCHEMA_SQL 加两表；新建 provider-model.repository.ts
4. ssrf-guard 复用 + zod 校验器：扩展 validateTarget 支持 allowInsecure；新建 model-source.schema.ts
5. registry 覆盖层：setSyncedProviders + listProviders 合并 + ProviderModel.capabilities
6. TDD 红线：先写 ModelSyncService 单元测试（失败）
7. ModelSyncService 实现：fetch+超时+重试+校验+合并+持久化+记日志+loadSnapshot+start/stop
8. 路由/控制器 + /sync-status 端点
9. runtime 装配：createRuntime 建 service + loadSnapshot；app.ts isMainModule fetchOnce().then(start)；runtime.close 清理
10. 集成测试：/providers 反映同步模型；/sync-status 反映上次运行；错误 URL → 记日志且不崩、静态目录仍可用
11. 客户端：settingsStore.refreshProviders + App 轮询 + ProviderZone 刷新按钮 + api.ts getSyncStatus
12. 桌面端：config/modelsync.json 读取 → process.env
13. 端到端验证闸门

依赖顺序：2→3→4→5 为 service 的前置依赖；第 6（写失败测试）必须在第 7（实现）之前（TDD）；9 依赖 7、8。

====================================================================
## 任务 1：Baseline（git init + 分支 + typecheck + 测试）

文件：仓库根
```bash
cd "C:/Users/Administrator/Desktop/新建文件夹 (2)"
git init -q
git add -A
git commit -q -m "baseline: CodeLens pre upstream-model-sync"
git checkout -b feature/upstream-model-sync
cd server && npm install   # 若 node_modules 缺失（注意 zod 4.6.7 / vitest ^5）
npm run typecheck          # 预期：无错误
npm test                   # 预期：adapter.test.ts 全绿
cd ../client && npx tsc --noEmit   # 预期：无错误（确认客户端类型基线）
```
验证：typecheck 0 错；`npm test` 绿；git 当前分支为 feature/upstream-model-sync。（若非 git 仓库，跳过 git 步骤，仅跑 typecheck/测试作基线。）

====================================================================
## 任务 2：env 配置（server/src/config/env.ts + server/.env.example）

修改 server/src/config/env.ts：
- 在 envSchema 内（约 L21 之后）新增：
```ts
  // ---- Upstream model sync (auto model fetch) ----
  MODEL_SOURCE_URL: z.string().default(''),
  MODEL_REFRESH_INTERVAL_MS: z.coerce.number().int().min(0).default(3600000),
  MODEL_SYNC_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),
  MODEL_SYNC_RETRY_BACKOFF_MS: z.coerce.number().int().min(0).default(1000),
  MODEL_SOURCE_ALLOW_INSECURE: z.string().default(''),
```
- 在 AppConfig 接口（约 L39 之后）新增：
```ts
  /** Upstream model-source URL; empty = 禁用自动拉取。 */
  modelSourceUrl: string;
  /** 周期刷新间隔（ms）；0/负 = 仅启动拉取一次。 */
  modelRefreshIntervalMs: number;
  modelSyncRetryMaxAttempts: number;
  modelSyncRetryBackoffMs: number;
  /** 允许 http（非 https）上游 URL。 */
  modelSourceAllowInsecure: boolean;
```
- buildConfig 内新增解析助手（放在 parseAllowedOrigins 附近）：
```ts
function parseBool(raw: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}
```
- 在 return 对象（约 L106 之前）新增：
```ts
    modelSourceUrl: env.MODEL_SOURCE_URL.trim(),
    modelRefreshIntervalMs: env.MODEL_REFRESH_INTERVAL_MS,
    modelSyncRetryMaxAttempts: env.MODEL_SYNC_RETRY_MAX_ATTEMPTS,
    modelSyncRetryBackoffMs: env.MODEL_SYNC_RETRY_BACKOFF_MS,
    modelSourceAllowInsecure: parseBool(env.MODEL_SOURCE_ALLOW_INSECURE),
```

修改 server/.env.example（若不存在则新建，追加）：
```
# ── Upstream model sync (auto model fetch) ──
# MODEL_SOURCE_URL=https://models.example.com/catalog.json
# MODEL_REFRESH_INTERVAL_MS=3600000
# MODEL_SYNC_RETRY_MAX_ATTEMPTS=3
# MODEL_SYNC_RETRY_BACKOFF_MS=1000
# MODEL_SOURCE_ALLOW_INSECURE=false
```

验证：`cd server && npm run typecheck`（无错）。

====================================================================
## 任务 3：DB schema + 仓储

修改 server/src/repositories/schema.ts：在 `provider_capabilities` 表定义之后、`schema_migrations` 之前，新增（追加进 SCHEMA_SQL 字符串）：
```sql
CREATE TABLE IF NOT EXISTS provider_models (
  provider          TEXT    NOT NULL,
  model             TEXT    NOT NULL,
  provider_name     TEXT    NOT NULL DEFAULT '',
  base_url          TEXT    NOT NULL DEFAULT '',
  default_model     TEXT    NOT NULL DEFAULT '',
  docs_url          TEXT    NOT NULL DEFAULT '',
  model_name        TEXT    NOT NULL DEFAULT '',
  capabilities_json TEXT,
  synced_at         INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);

CREATE TABLE IF NOT EXISTS model_sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  status      TEXT    NOT NULL CHECK (status IN ('success', 'error', 'disabled')),
  attempt     INTEGER NOT NULL DEFAULT 1,
  message     TEXT    NOT NULL,
  detail      TEXT,
  source_url  TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_model_sync_log_occurred ON model_sync_log(occurred_at DESC);
```

新建 server/src/repositories/provider-model.repository.ts（镜像 provider-capability.repository.ts 模式）：
```ts
import type { Db } from './db.js';
import type { ProviderInfo, ProviderModel } from '../types/index.js';

export type SyncStatus = 'success' | 'error' | 'disabled';
export type ModelSyncLastStatus = SyncStatus | 'never';

export interface SyncLogRow {
  id: number;
  occurred_at: number;
  status: SyncStatus;
  attempt: number;
  message: string;
  detail: string | null;
  source_url: string;
}

export interface ModelSyncStatus {
  lastRunAt: number | null;
  lastStatus: ModelSyncLastStatus;
  lastError: string | null;
  lastProviderCount: number | null;
  lastModelCount: number | null;
  sourceUrl: string;
}

export interface UpsertProviderModelInput {
  provider: string;
  model: string;
  providerName: string;
  baseUrl: string;
  defaultModel: string;
  docsUrl: string;
  modelName: string;
  capabilities?: ProviderModel['capabilities'];
  syncedAt: number;
}

export interface InsertLogInput {
  occurredAt: number;
  status: SyncStatus;
  attempt: number;
  message: string;
  detail?: unknown;
  sourceUrl?: string;
}

export class ProviderModelRepository {
  constructor(private readonly db: Db) {}

  /** 用一次成功同步的 provider 列表整体覆盖快照（先清后写，保证与上游一致）。 */
  replaceSnapshot(providers: ProviderInfo[]): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM provider_models');
      const now = Date.now();
      for (const p of providers) {
        for (const m of p.models) {
          this.db.run(
            `INSERT INTO provider_models
               (provider, model, provider_name, base_url, default_model, docs_url,
                model_name, capabilities_json, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              p.id, m.id, p.name, p.baseUrl, p.defaultModel, p.docsUrl,
              m.name, m.capabilities ? JSON.stringify(m.capabilities) : null, now,
            ],
          );
        }
      }
    });
  }

  /** 重建最近一次成功快照为 ProviderInfo[]（用于重启后首拉前的兜底合并）。 */
  getLatestSnapshot(): ProviderInfo[] {
    const rows = this.db.all<{
      provider: string; model: string; provider_name: string; base_url: string;
      default_model: string; docs_url: string; model_name: string;
      capabilities_json: string | null;
    }>('SELECT * FROM provider_models ORDER BY provider, model');
    const byProvider = new Map<string, ProviderInfo>();
    for (const r of rows) {
      const p = byProvider.get(r.provider) ?? {
        id: r.provider, name: r.provider_name, baseUrl: r.base_url,
        defaultModel: r.default_model, docsUrl: r.docsUrl, models: [],
      };
      p.models.push({
        id: r.model, name: r.model_name,
        ...(r.capabilities_json ? { capabilities: JSON.parse(r.capabilities_json) } : {}),
      });
      byProvider.set(r.provider, p);
    }
    return [...byProvider.values()];
  }
}

export class ModelSyncLogRepository {
  constructor(private readonly db: Db) {}

  insert(entry: InsertLogInput): void {
    this.db.run(
      `INSERT INTO model_sync_log (occurred_at, status, attempt, message, detail, source_url)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        entry.occurredAt, entry.status, entry.attempt, entry.message,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
        entry.sourceUrl ?? '',
      ],
    );
  }

  recent(limit = 20): SyncLogRow[] {
    return this.db.all<SyncLogRow>(
      'SELECT * FROM model_sync_log ORDER BY occurred_at DESC LIMIT ?',
      [limit],
    );
  }

  /** 由最近一条日志推算状态（无日志 = never）。 */
  status(sourceUrl: string): ModelSyncStatus {
    const row = this.db.get<SyncLogRow>(
      'SELECT * FROM model_sync_log ORDER BY occurred_at DESC LIMIT 1',
    );
    if (!row) {
      return {
        lastRunAt: null, lastStatus: 'never', lastError: null,
        lastProviderCount: null, lastModelCount: null, sourceUrl,
      };
    }
    const detail = row.detail ? (JSON.parse(row.detail) as { providerCount?: number; modelCount?: number }) : {};
    return {
      lastRunAt: row.occurred_at,
      lastStatus: row.status,
      lastError: row.status === 'error' ? row.message : null,
      lastProviderCount: detail.providerCount ?? null,
      lastModelCount: detail.modelCount ?? null,
      sourceUrl,
    };
  }
}
```

验证：`cd server && npm run typecheck`（无错）。（运行期迁移在 createRuntime 启动时自动执行。）

====================================================================
## 任务 4：ssrf-guard 复用 + zod 校验器

修改 server/src/utils/ssrf-guard.ts（向后兼容地扩展）：
- 在 `inspectUrl` 签名加可选 opts，并用它覆盖 `insecureHttpAllowed()`：
```ts
export function inspectUrl(rawUrl: string, opts?: { allowInsecure?: boolean }): UrlVerdict {
  ...
  if (url.protocol === 'http:' && !(opts?.allowInsecure ?? insecureHttpAllowed())) {
    return { ok: false, reason: 'NON_HTTPS', message: '默认只允许 https，请开启 allowInsecure' };
  }
  ...
}
```
- 在 `validateTarget` 签名加可选 opts 并透传：
```ts
export async function validateTarget(
  rawUrl: string,
  opts?: { allowInsecure?: boolean },
): Promise<UrlVerdict> {
  const base = inspectUrl(rawUrl, opts);
  ...
}
```
（仅改签名与两处透传，逻辑不变。）

新建 server/src/validators/model-source.schema.ts（strict + refine，对齐 §6 默认契约）：
```ts
import { z } from 'zod';

const ModelCapabilitiesSchema = z
  .object({
    function_calling: z.boolean().optional(),
    context_window: z.number().int().positive().optional(),
  })
  .strict();

const ModelSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    capabilities: ModelCapabilitiesSchema.optional(),
  })
  .strict();

const ProviderSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(128),
    baseUrl: z.string().min(1).max(512),
    defaultModel: z.string().max(128).optional().default(''),
    docsUrl: z.string().max(512).optional().default(''),
    models: z.array(ModelSchema).default([]),
  })
  .strict();

export const ModelSourceSchema = z
  .object({
    providers: z.array(ProviderSchema).min(1, 'providers 不能为空'),
  })
  .strict()
  .refine(
    (data) => {
      const pids = new Set<string>();
      for (const p of data.providers) {
        if (pids.has(p.id)) return false;
        pids.add(p.id);
        const mids = new Set<string>();
        for (const m of p.models) {
          if (mids.has(m.id)) return false;
          mids.add(m.id);
        }
      }
      return true;
    },
    { message: 'provider.id / model.id 必须全局唯一' },
  );

export type ModelSourceProvider = z.infer<typeof ProviderSchema>;
export type ModelSource = z.infer<typeof ModelSourceSchema>;
```

验证：`cd server && npm run typecheck`。

====================================================================
## 任务 5：registry 覆盖层

修改 server/src/providers/registry.ts：
- 扩展 ProviderModel 类型在其定义处加可选 capabilities（在 server/src/types/index.ts）：
```ts
export interface ProviderModel {
  id: string;
  name: string;
  capabilities?: { function_calling?: boolean; context_window?: number };
}
```
- 在 registry.ts 顶部 PROVIDERS 之后新增模块级覆盖层与合并逻辑（替换原 listProviders / getProvider 的返回构建，并新增 setSyncedProviders）：
```ts
const SYNCED = new Map<string, ProviderInfo>();

function cloneProvider(p: ProviderInfo): ProviderInfo {
  return { ...p, models: p.models.map((m) => ({ ...m })) };
}

/** ModelSyncService 写入的「同步覆盖层」（按 id 覆盖静态默认）。 */
export function setSyncedProviders(list: ProviderInfo[]): void {
  SYNCED.clear();
  for (const p of list) SYNCED.set(p.id, cloneProvider(p));
}

export function listProviders(): ProviderInfo[] {
  const ids = new Set<string>([...PROVIDERS.map((p) => p.id), ...SYNCED.keys()]);
  const out: ProviderInfo[] = [];
  for (const id of ids) {
    const base = BY_ID.get(id);
    const synced = SYNCED.get(id);
    if (!synced) {
      out.push(cloneProvider(base!));
    } else if (!base) {
      out.push(cloneProvider(synced));
    } else {
      const mergedModels = new Map<string, ProviderModel>();
      for (const m of base.models) mergedModels.set(m.id, { ...m });
      for (const m of synced.models) mergedModels.set(m.id, { ...m }); // 同步模型优先（含 capabilities）
      out.push({
        id: base.id,
        name: synced.name || base.name,
        baseUrl: synced.baseUrl || base.baseUrl,
        defaultModel: synced.defaultModel || base.defaultModel,
        docsUrl: synced.docsUrl || base.docsUrl,
        models: [...mergedModels.values()],
      });
    }
  }
  return out;
}
```
（getProvider / isModelOfProvider / resolveBaseUrl 保持不变；它们是读 BY_ID 的静态视图，不影响合并目录与同步能力。）

验证：`cd server && npm run typecheck`。

====================================================================
## 任务 6（TDD 红线）：先写 ModelSyncService 单元测试（预期失败）

新建 server/tests/model-sync.service.test.ts（此时 service 尚不存在 → 运行必红）：
```ts
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { setSyncedProviders, listProviders } from '../src/providers/registry.js';
import { ProviderModelRepository, ModelSyncLogRepository } from '../src/repositories/provider-model.repository.js';
import { ModelSyncService } from '../src/services/model-sync/model-sync.service.js';
import { ModelSourceSchema } from '../src/validators/model-source.schema.js';

function makeService(overrides: Partial<{
  sourceUrl: string; fetchImpl: typeof fetch; logRows: unknown[]; snap: unknown[];
}> = {}) {
  const providerRepo = {
    replaceSnapshot: vi.fn(), getLatestSnapshot: vi.fn(() => (overrides.snap as any) ?? []),
  } as unknown as ProviderModelRepository;
  const logRepo = {
    insert: vi.fn(), recent: vi.fn(() => (overrides.logRows as any) ?? []),
    status: vi.fn(() => ({ lastRunAt: null, lastStatus: 'never', lastError: null,
      lastProviderCount: null, lastModelCount: null, sourceUrl: overrides.sourceUrl ?? '' })),
  } as unknown as ModelSyncLogRepository;
  const config = {
    sourceUrl: overrides.sourceUrl ?? 'https://up.example/catalog.json',
    refreshIntervalMs: 0, retryMaxAttempts: 3, retryBackoffMs: 10,
    allowInsecure: false, timeoutMs: 1000, logFilePath: '',
  };
  const svc = new ModelSyncService(providerRepo, logRepo, config,
    overrides.fetchImpl ?? (async () => new Response('{}')), '');
  return { svc, providerRepo, logRepo };
}

describe('ModelSyncService (TDD red)', () => {
  beforeEach(() => setSyncedProviders([]));

  it('validateAndNormalize 正常响应通过', () => {
    const ok = ModelSourceSchema.safeParse({
      providers: [{ id: 'x', name: 'X', baseUrl: 'https://x/v1',
        models: [{ id: 'm', name: 'M', capabilities: { function_calling: true } }] }],
    });
    expect(ok.success).toBe(true);
  });

  it('validateAndNormalize 缺字段/畸形被拒', () => {
    expect(ModelSourceSchema.safeParse({ providers: [{ id: 'x' }] }).success).toBe(false);
    expect(ModelSourceSchema.safeParse({ providers: [{ id: 'x', name: 'X', baseUrl: 'https://x',
      models: [{ id: 'm' }, { id: 'm' }] }] }).success).toBe(false); // 重复 model.id
  });

  it('fetchOnce 成功后合并进 registry 并落快照+日志', async () => {
    const body = JSON.stringify({ providers: [{ id: 'newp', name: 'New', baseUrl: 'https://new/v1',
      models: [{ id: 'nm', name: 'NM' }] }] });
    const { svc, providerRepo, logRepo } = makeService({
      fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await svc.fetchOnce();
    expect(listProviders().some((p) => p.id === 'newp')).toBe(true);
    expect(providerRepo.replaceSnapshot).toHaveBeenCalled();
    expect(logRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });

  it('fetchOnce 连续失败至耗尽后记录 error 且不抛', async () => {
    const { svc, logRepo } = makeService({
      retryMaxAttempts: 3, retryBackoffMs: 1,
      fetchImpl: async () => { throw new Error('boom'); },
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
});
```
运行红线：`cd server && npx vitest run tests/model-sync.service.test.ts` → 因模块不存在失败（预期红）。

====================================================================
## 任务 7：ModelSyncService 实现（使任务 6 转绿）

新建 server/src/services/model-sync/model-sync.service.ts：
```ts
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { ModelSourceSchema, type ModelSourceProvider } from '../../validators/model-source.schema.js';
import { validateTarget } from '../../utils/ssrf-guard.js';
import { setSyncedProviders, listProviders } from '../../providers/registry.js';
import type { ProviderInfo, ProviderModel } from '../../types/index.js';
import type {
  ProviderModelRepository, ModelSyncLogRepository, ModelSyncStatus, SyncLogRow,
} from '../../repositories/provider-model.repository.js';

export interface ModelSyncServiceConfig {
  sourceUrl: string;
  refreshIntervalMs: number;
  retryMaxAttempts: number;
  retryBackoffMs: number;
  allowInsecure: boolean;
  timeoutMs: number;
  logFilePath: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class ModelSyncService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly providerRepo: ProviderModelRepository,
    private readonly logRepo: ModelSyncLogRepository,
    private readonly cfg: ModelSyncServiceConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  /** 用 DB 中最近一次成功快照预热 registry（重启后首拉前仍有上次数据）。 */
  loadSnapshot(): void {
    if (this.cfg.sourceUrl.trim() === '') return; // 禁用时无需预热（静态目录即兜底）
    const snap = this.providerRepo.getLatestSnapshot();
    if (snap.length > 0) setSyncedProviders(snap);
  }

  /** 单次同步：SSRF 校验 → fetch(超时) → zod 校验 → 合并 → 持久化 → 记录。失败不冒泡。 */
  async fetchOnce(): Promise<void> {
    const sourceUrl = this.cfg.sourceUrl.trim();
    if (sourceUrl === '') {
      this.logRepo.insert({ occurredAt: Date.now(), status: 'disabled', attempt: 0,
        message: 'MODEL_SOURCE_URL 为空，自动拉取已禁用', sourceUrl: '' });
      return;
    }
    const verdict = await validateTarget(sourceUrl, { allowInsecure: this.cfg.allowInsecure });
    if (!verdict.ok) {
      const msg = `上游 URL 被 SSRF 防护拒绝：${verdict.reason} ${verdict.message ?? ''}`.trim();
      this.logRepo.insert({ occurredAt: Date.now(), status: 'error', attempt: 0,
        message: msg, detail: { reason: verdict.reason }, sourceUrl });
      this.appendLogFile(`[disabled] ${msg}`);
      return;
    }

    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= this.cfg.retryMaxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs || DEFAULT_TIMEOUT_MS);
        const res = await this.fetchImpl(sourceUrl, { signal: controller.signal } as RequestInit);
        clearTimeout(timer);
        if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`);
        const raw = await res.json();
        const parsed = ModelSourceSchema.safeParse(raw);
        if (!parsed.success) {
          const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
          throw new Error(`上游响应校验失败：${detail}`);
        }
        const providers = parsed.data.providers.map(normalizeProvider);
        setSyncedProviders(providers);
        this.providerRepo.replaceSnapshot(providers);
        const modelCount = providers.reduce((n, p) => n + p.models.length, 0);
        this.logRepo.insert({ occurredAt: Date.now(), status: 'success', attempt,
          message: `同步成功：${providers.length} 个 provider / ${modelCount} 个模型`,
          detail: { providerCount: providers.length, modelCount }, sourceUrl });
        this.appendLogFile(`[success] attempt=${attempt} providers=${providers.length} models=${modelCount}`);
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        this.logRepo.insert({ occurredAt: Date.now(), status: 'error', attempt,
          message: msg, detail: { phase: 'fetch_or_validate' }, sourceUrl });
        if (attempt < this.cfg.retryMaxAttempts) {
          await new Promise((r) => setTimeout(r, this.cfg.retryBackoffMs * 2 ** (attempt - 1)));
        }
      }
    }
    const finalMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    this.appendLogFile(`[error] ${finalMsg}`);
  }

  /** 启动周期调度（仅当 sourceUrl 非空且间隔 > 0）。调用方应先 fetchOnce 一次。 */
  start(): void {
    if (this.cfg.sourceUrl.trim() === '' || this.cfg.refreshIntervalMs <= 0) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return; // 防止上次未结束重叠
      this.running = true;
      void this.fetchOnce().finally(() => { this.running = false; });
    }, this.cfg.refreshIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  status(): ModelSyncStatus {
    return this.logRepo.status(this.cfg.sourceUrl);
  }

  recentLogs(limit = 20): SyncLogRow[] {
    return this.logRepo.recent(limit);
  }

  private appendLogFile(line: string): void {
    if (!this.cfg.logFilePath) return;
    try {
      const dir = path.dirname(this.cfg.logFilePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(this.cfg.logFilePath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch { /* 日志落盘失败不致命 */ }
  }
}

function normalizeProvider(p: ModelSourceProvider): ProviderInfo {
  return {
    id: p.id, name: p.name, baseUrl: p.baseUrl,
    defaultModel: p.defaultModel ?? '', docsUrl: p.docsUrl ?? '',
    models: p.models.map((m) => ({
      id: m.id, name: m.name,
      ...(m.capabilities ? { capabilities: {
        function_calling: m.capabilities.function_calling,
        context_window: m.capabilities.context_window,
      } } : {}),
    })) as ProviderModel[],
  };
}
```

验证：`cd server && npx vitest run tests/model-sync.service.test.ts` → 全绿。

====================================================================
## 任务 8：路由/控制器 + /sync-status

修改 server/src/controllers/providers.controller.ts：
- constructor 增加第二个可选参数 modelSync：
```ts
import type { ModelSyncService } from '../services/model-sync/model-sync.service.js';
...
constructor(
  private readonly capabilities: { list(): ProviderCapabilityRow[] },
  private readonly modelSync?: Pick<ModelSyncService, 'status' | 'recentLogs'>,
) {}
```
- list() 内让同步 capabilities 优先生效（在 models.map 的 `row ? ... : defaults` 之后叠加）。把
```ts
        return {
          id: model.id,
          name: model.name,
          capabilities: row ? { ... } : defaults,
          probeStatus: row?.probe_status ?? 'unknown',
        };
```
改为：
```ts
        const synced = model.capabilities;
        const baseCaps = row
          ? { nativeTools: row.supports_function_calling === 1,
              toolChoiceValues: row.tool_choice_values_json ? (JSON.parse(row.tool_choice_values_json) as string[]) : defaults.toolChoiceValues,
              contextWindow: row.context_window ?? defaults.contextWindow,
              retainReasoningContent: row.retain_reasoning_content === 1,
              requireToolStreamFlag: row.require_tool_stream_flag === 1,
              explicitParallelToolCalls: row.explicit_parallel_tool_calls === 1 }
          : defaults;
        const caps = {
          nativeTools: synced?.function_calling ?? baseCaps.nativeTools,
          toolChoiceValues: baseCaps.toolChoiceValues,
          contextWindow: synced?.context_window ?? baseCaps.contextWindow,
          retainReasoningContent: baseCaps.retainReasoningContent,
          requireToolStreamFlag: baseCaps.requireToolStreamFlag,
          explicitParallelToolCalls: baseCaps.explicitParallelToolCalls,
        };
        return { id: model.id, name: model.name, capabilities: caps, probeStatus: row?.probe_status ?? 'unknown' };
```
- 新增方法：
```ts
  syncStatus(_req: Request, res: Response): void {
    const status = this.modelSync?.status() ?? {
      lastRunAt: null, lastStatus: 'never' as const, lastError: null,
      lastProviderCount: null, lastModelCount: null, sourceUrl: '',
    };
    const recentLogs = this.modelSync?.recentLogs(10) ?? [];
    res.json({ sync: status, recentLogs });
  }
```

修改 server/src/routes/providers.routes.ts（在 `/providers/capabilities` 之后加）：
```ts
  router.get('/providers/sync-status', (req, res) => controller.syncStatus(req, res));
```

验证：`cd server && npm run typecheck`。

====================================================================
## 任务 9：runtime 装配 + app.ts 启动钩子

修改 server/src/runtime.ts：
- 顶部 import：
```ts
import { ProviderModelRepository, ModelSyncLogRepository } from './repositories/provider-model.repository.js';
import { ModelSyncService } from './services/model-sync/model-sync.service.js';
import { config } from './config/env.js';
import path from 'node:path';
```
- Runtime 接口（约 L49）新增：`modelSync: ModelSyncService;`
- createRuntime 签名改为 `createRuntime(opts?: { dbPath?: string; fetchImpl?: typeof fetch })`：
```ts
export function createRuntime(opts: { dbPath?: string; fetchImpl?: typeof fetch } = {}): Runtime {
  const dbPath = opts.dbPath ?? config.agentDbPath;
  ...
  const providerModels = new ProviderModelRepository(db);
  const modelSyncLog = new ModelSyncLogRepository(db);
  const modelSync = new ModelSyncService(
    providerModels, modelSyncLog,
    {
      sourceUrl: config.modelSourceUrl,
      refreshIntervalMs: config.modelRefreshIntervalMs,
      retryMaxAttempts: config.modelSyncRetryMaxAttempts,
      retryBackoffMs: config.modelSyncRetryBackoffMs,
      allowInsecure: config.modelSourceAllowInsecure,
      timeoutMs: 60_000,
      logFilePath: path.join(config.agentDbPath ? path.dirname(config.agentDbPath) : '.', 'logs', 'model-sync.log'),
    },
    opts.fetchImpl ?? globalThis.fetch,
  );
  modelSync.loadSnapshot(); // 用 DB 快照预热，重启首拉前不丢数据
  ...
  const providersController = new ProvidersController(capabilities, modelSync);
  ...
  return {
    ...,
    modelSync,
    close: async () => {
      modelSync.stop();
      await mcpManager.closeAll();
      db.close();
    },
  };
}
```
注意：`logFilePath` 落在 agentDb 同目录的 logs/（与桌面端 dataDir 一致）。若 agentDbPath 为 :memory: 则用当前目录 ./logs（测试无影响，因为测试不依赖文件日志）。

修改 server/src/app.ts 的 isMainModule 分支（约 L105）：
```ts
if (isMainModule()) {
  const runtime = createRuntime();
  const app = createApp({ runtime });
  const server = app.listen(config.port, () => {
    console.log(`codelens-server listening on :${config.port} (${config.nodeEnv})`);
  });
  const sync = runtime.modelSync;
  void sync.fetchOnce().then(() => sync.start());
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      sync.stop();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}
```
（createApp 内部 `options.runtime ?? createRuntime()` 仍保留；但主模块分支显式传 runtime 以便控制 service。）

验证：`cd server && npm run typecheck`；`cd server && npx vitest run`（既有测试仍绿）。

====================================================================
## 任务 10：集成测试

新建 server/tests/model-sync.integration.test.ts：
```ts
process.env.NODE_ENV = 'test';
process.env.MODEL_SOURCE_URL = 'https://upstream.test/catalog.json';

const { createRuntime } = await import('../src/runtime.js');
const { createApp } = await import('../src/app.js');
const request = (await import('supertest')).default;

function fakeFetch(body: unknown, status = 200) {
  return async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  }) as unknown as Response;
}

describe('upstream model sync integration', () => {
  it('GET /api/v1/providers 反映同步模型；/sync-status 反映成功', async () => {
    const runtime = createRuntime({
      dbPath: ':memory:',
      fetchImpl: fakeFetch({ providers: [{ id: 'synced', name: 'Synced',
        baseUrl: 'https://synced/v1', models: [{ id: 's1', name: 'S1' }] }] }),
    });
    const app = createApp({ runtime });
    await runtime.modelSync.fetchOnce();

    const provRes = await request(app).get('/api/v1/providers');
    expect(provRes.status).toBe(200);
    expect(provRes.body.providers.some((p: any) => p.id === 'synced')).toBe(true);

    const statusRes = await request(app).get('/api/v1/providers/sync-status');
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.sync.lastStatus).toBe('success');
    expect(statusRes.body.sync.lastProviderCount).toBe(1);

    await runtime.close();
  });

  it('错误 URL → 记日志且不崩；静态目录仍可用', async () => {
    const runtime = createRuntime({
      dbPath: ':memory:',
      fetchImpl: async () => { throw new Error('network down'); },
    });
    const app = createApp({ runtime });
    await runtime.modelSync.fetchOnce(); // 不应抛

    const provRes = await request(app).get('/api/v1/providers');
    expect(provRes.status).toBe(200);
    expect(provRes.body.providers.length).toBeGreaterThanOrEqual(6); // 静态 6 家仍在

    const statusRes = await request(app).get('/api/v1/providers/sync-status');
    expect(statusRes.body.sync.lastStatus).toBe('error');

    await runtime.close();
  });

  it('MODEL_SOURCE_URL 为空 → disabled 且静态目录可用', async () => {
    process.env.MODEL_SOURCE_URL = '';
    const { createRuntime: cr2 } = await import('../src/runtime.js');
    const runtime = cr2({ dbPath: ':memory:' });
    const app = createApp({ runtime });
    await runtime.modelSync.fetchOnce();
    const provRes = await request(app).get('/api/v1/providers');
    expect(provRes.body.providers.length).toBeGreaterThanOrEqual(6);
    const statusRes = await request(app).get('/api/v1/providers/sync-status');
    expect(statusRes.body.sync.lastStatus).toBe('disabled');
    await runtime.close();
    process.env.MODEL_SOURCE_URL = 'https://upstream.test/catalog.json';
  });
});
```
验证：`cd server && npx vitest run tests/model-sync.integration.test.ts` → 全绿。再跑 `npm test` 全量绿。

====================================================================
## 任务 11：客户端（settingsStore + App + ProviderZone + api）

修改 client/src/stores/settingsStore.ts：
- SettingsState 接口（约 L99）新增：`refreshProviders: (notify?: boolean) => Promise<void>;`
- 在 setProviders 之后实现：
```ts
  refreshProviders: async (notify = false) => {
    try {
      const list = await getProviders();
      if (list.length > 0) get().setProviders(list);
      if (notify) useUiStore.getState().pushToast({ message: '模型列表已刷新', variant: 'success' });
    } catch (err) {
      if (notify) {
        const msg = err instanceof Error ? err.message : '未知错误';
        useUiStore.getState().pushToast({ message: `刷新模型列表失败：${msg}`, variant: 'error' });
      }
    }
  },
```
（顶部需 `import { getProviders } from '../services/api';` 若尚未存在；useUiStore 已引入。）

修改 client/src/App.tsx：把现有 getProviders().then(setProviders) 替换为轮询：
```ts
import { useEffect } from 'react';
...
import { useSettingsStore } from './stores/settingsStore';
import { getProviders } from './services/api';

const UI_POLL_MS = 5 * 60 * 1000; // 仅刷新 UI，不重复拉取上游

export default function App() {
  useTheme();
  useEffect(() => {
    void useServerSessionStore.getState().loadList();
    void useSettingsStore.getState().refreshProviders(false); // 启动静默刷新
    const id = setInterval(() => {
      void useSettingsStore.getState().refreshProviders(false);
    }, UI_POLL_MS);
    return () => { clearInterval(id); onStorageChange(() => undefined); };
  }, []);
  ...
}
```

修改 client/src/services/api.ts：新增 getSyncStatus（约 L109 之后）：
```ts
/** GET /api/v1/providers/sync-status —— 最近同步状态（可选展示） */
export async function getProviderSyncStatus(): Promise<{
  sync: { lastRunAt: number | null; lastStatus: string; lastError: string | null;
          lastProviderCount: number | null; lastModelCount: number | null; sourceUrl: string };
  recentLogs: Array<{ id: number; occurred_at: number; status: string; attempt: number; message: string }>;
}> {
  return get('/providers/sync-status');
}
```

修改 client/src/components/settings/ProviderZone.tsx：在「模型」Field 下方（约 L179 之后）新增刷新按钮：
```tsx
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void useSettingsStore.getState().refreshProviders(true)}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-primary transition-colors duration-150 hover:border-accent"
        >
          刷新模型列表
        </button>
      </div>
```
（useSettingsStore 已在组件顶部 import。）

验证：`cd client && npx tsc --noEmit`（无错）；`cd server && npx vitest run`（无回归）。

====================================================================
## 任务 12：桌面端 config/modelsync.json → env

修改 desktop/main.cjs（在「启动内嵌服务端」之前的 env 注入区，约 L75 之后、`require('./server-bundle.cjs')` 之前插入）：
```js
// ── 上游模型同步配置：config/modelsync.json（gitignore）→ process.env（env 优先） ──
const MODELSYNC_ENV = {
  MODEL_SOURCE_URL: 'MODEL_SOURCE_URL',
  MODEL_REFRESH_INTERVAL_MS: 'MODEL_REFRESH_INTERVAL_MS',
  MODEL_SYNC_RETRY_MAX_ATTEMPTS: 'MODEL_SYNC_RETRY_MAX_ATTEMPTS',
  MODEL_SYNC_RETRY_BACKOFF_MS: 'MODEL_SYNC_RETRY_BACKOFF_MS',
  MODEL_SOURCE_ALLOW_INSECURE: 'MODEL_SOURCE_ALLOW_INSECURE',
};
function loadModelSyncConfig() {
  const file = isPackaged
    ? path.join(dataDir, 'config', 'modelsync.json')
    : path.join(repoRoot, 'config', 'modelsync.json');
  let cfg = {};
  try {
    if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    cfg = {};
  }
  for (const [key, env] of Object.entries(MODELSYNC_ENV)) {
    const val = cfg[key];
    if (val !== undefined && val !== null && String(val).trim() !== '' && process.env[env] === undefined) {
      process.env[env] = String(val); // env 已设置则优先于文件
    }
  }
}
loadModelSyncConfig();
```

修改根 .gitignore：追加一行 `config/modelsync.json`（保持示例不被提交；可另附 config/modelsync.example.json 供参考）。

验证：`cd server && npm run typecheck`；人工确认桌面启动时若 config/modelsync.json 含 MODEL_SOURCE_URL 则 env 生效（见任务 13）。

====================================================================
## 任务 13：端到端验证闸门（Final Gate）

1. 类型闸门（服务端 + 客户端）：
```bash
cd "C:/Users/Administrator/Desktop/新建文件夹 (2)/server" && npm run typecheck
cd "C:/Users/Administrator/Desktop/新建文件夹 (2)/client" && npx tsc --noEmit
```
2. 单测 + 集成测试全绿：
```bash
cd "C:/Users/Administrator/Desktop/新建文件夹 (2)/server" && npm test
```
3. 手动冒烟（dev 态）：
```bash
# 在 server 目录设置 env 后启动
MODEL_SOURCE_URL=https://your-upstream/catalog.json MODEL_REFRESH_INTERVAL_MS=10000 npx tsx src/app.ts
curl -s http://127.0.0.1:8080/api/v1/providers | head   # 应含同步模型 + 静态 6 家
curl -s http://127.0.0.1:8080/api/v1/providers/sync-status  # lastStatus=success
# 故意错误 URL → 重启/请求后 sync-status.lastStatus=error，且 /providers 仍返回静态目录
```
4. 桌面端冒烟：在 config/modelsync.json 写入 `{"MODEL_SOURCE_URL":"https://..."}` 后 `npm run build`（或 dev）启动 Electron，打开设置 → 模型下拉应出现同步模型；点击「刷新模型列表」有 Toast。

====================================================================
## OPEN QUESTIONS（待确认）
1. **DB 迁移机制**：已接受——沿用「启动时 db.exec(SCHEMA_SQL) + CREATE TABLE IF NOT EXISTS」模式（与 provider_capabilities 一致）。`provider_models` / `model_sync_log` 两表已加入 `schema.ts` 的 SCHEMA_SQL。
2. **ssrf-guard 复用安全性**：已实现——`inspectUrl` / `validateTarget` 增加向后兼容的可选 `opts?.allowInsecure`，`MODEL_SOURCE_ALLOW_INSECURE` 独立生效，不影响 `HTTP_ALLOW_INSECURE`（http 工具开关）。
3. **ssrf-guard 在测试中的 DNS 解析**：已解决——`ModelSyncService` 新增 `validateUrl` DI 注入点（默认 `validateTarget`），单测与集成测试注入始终返回 ok 的桩，避免依赖真实网络；`createRuntime` 新增 `validateUrl` 选项透传。Open Question 建议的「本地 http 桩」因 ssrf-guard 会拦截 127.0.0.0/8 故不可行，DI 桩是更干净的做法。
4. **同步覆盖 custom provider**：已实现允许（无害）——合并时按 id 覆盖，custom 的空 baseUrl 回退到静态默认。
5. **客户端轮询默认 5 分钟**：已实现——`App.tsx` 启动静默 `refreshProviders(false)` + `setInterval(refreshProviders, 5min)`，仅刷新 UI（重新拉 /providers），不重复打上游；设置页新增「刷新模型列表」按钮（`notify=true` 时 Toast 反馈）。

## 实施结果（2026-10-23）
- 服务端：新增 `services/model-sync/model-sync.service.ts`、`validators/model-source.schema.ts`、`repositories/provider-model.repository.ts`；扩展 `config/env.ts`（5 项配置）、`utils/ssrf-guard.ts`（allowInsecure 透传）、`providers/registry.ts`（SYNCED 覆盖层 + `setSyncedProviders` + 合并）、`controllers/providers.controller.ts`（合并 synced capabilities + `syncStatus`）、`routes/providers.routes.ts`（`/providers/sync-status`）、`runtime.ts`（装配 + `loadSnapshot` + `close` 清理）、`app.ts`（isMainModule 启动即 fetchOnce 再 start）。
- DB：新增 `provider_models`（最近成功快照）、`model_sync_log`（同步状态/异常记录）。
- 客户端：`settingsStore.refreshProviders`、`App.tsx` 轮询、`api.getProviderSyncStatus`、`ProviderZone` 刷新按钮。
- 桌面端：`main.cjs` 读取 `config/modelsync.json` → process.env（env 优先）；`.gitignore` 忽略该文件；新增 `config/modelsync.example.json` 与 `server/.env.example` 区块。
- 校验：`server` typecheck 通过；`npm test` 133 项全绿（含 6 单测 + 3 集成）；`client` tsc --noEmit 通过；`desktop/main.cjs` node --check 通过。
