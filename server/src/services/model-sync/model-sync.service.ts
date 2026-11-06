/**
 * ModelSyncService: 自动获取上游模型。
 * 流程：SSRF 校验 → fetch(超时) → zod 校验 → 合并进 registry → 持久化快照 → 记录日志。
 * 失败不冒泡（仅记录并返回），保证静态 provider 目录始终可用。
 *
 * 调度：start() 仅当 sourceUrl 非空且间隔 > 0 时启用 setInterval().unref()；
 * 调用方应先用 fetchOnce() 拉一次，再 start()。
 */

import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { ModelSourceSchema, type ModelSourceProvider } from '../../validators/model-source.schema.js';
import { validateTarget, type UrlVerdict } from '../../utils/ssrf-guard.js';
import { setSyncedProviders } from '../../providers/registry.js';
import type { ProviderInfo, ProviderModel } from '../../types/index.js';
import type {
  ProviderModelRepository,
  ModelSyncLogRepository,
  ModelSyncStatus,
  SyncLogRow,
} from '../../repositories/provider-model.repository.js';

export interface ModelSyncServiceConfig {
  sourceUrl: string;
  refreshIntervalMs: number;
  retryMaxAttempts: number;
  retryBackoffMs: number;
  allowInsecure: boolean;
  /** 允许私有/回环网段上游（如 127.0.0.1、内网 IP）。默认 false，SSRF 防护仍拦截。 */
  allowPrivate?: boolean;
  /** 上游响应格式：native=按 ModelSourceSchema（失败自动探测 OpenAI 列表）；openai=显式按 /v1/models 列表。 */
  format?: 'native' | 'openai';
  timeoutMs: number;
  logFilePath: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** SSRF 校验钩子（可注入以便测试，默认走真实 ssrf-guard）。 */
export type ValidateUrl = (
  rawUrl: string,
  opts?: { allowInsecure?: boolean; allowPrivate?: boolean },
) => Promise<UrlVerdict>;

export class ModelSyncService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly providerRepo: ProviderModelRepository,
    private readonly logRepo: ModelSyncLogRepository,
    private readonly cfg: ModelSyncServiceConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly validateUrl: ValidateUrl = validateTarget,
  ) {}

  /** 用 DB 中最近一次成功快照预热 registry（重启后首拉前仍有上次数据）。 */
  loadSnapshot(): void {
    if (this.cfg.sourceUrl.trim() === '') return; // 禁用时无需预热（静态目录即兜底）
    const snap = this.providerRepo.getLatestSnapshot();
    if (snap.length > 0) setSyncedProviders(snap);
  }

  /** 单次同步：校验 → fetch(超时) → zod → 合并 → 持久化 → 记录。失败不冒泡。 */
  async fetchOnce(): Promise<void> {
    const sourceUrl = this.cfg.sourceUrl.trim();
    if (sourceUrl === '') {
      this.logRepo.insert({
        occurredAt: Date.now(), status: 'disabled', attempt: 0,
        message: 'MODEL_SOURCE_URL 为空，自动拉取已禁用', sourceUrl: '',
      });
      return;
    }

    const verdict = await this.validateUrl(sourceUrl, {
      allowInsecure: this.cfg.allowInsecure,
      allowPrivate: this.cfg.allowPrivate,
    });
    if (!verdict.ok) {
      const msg = `上游 URL 被 SSRF 防护拒绝：${verdict.reason} ${verdict.message ?? ''}`.trim();
      this.logRepo.insert({
        occurredAt: Date.now(), status: 'error', attempt: 0,
        message: msg, detail: { reason: verdict.reason }, sourceUrl,
      });
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
        let parsed: ReturnType<typeof ModelSourceSchema.safeParse> | null = null;
        if (this.cfg.format === 'openai') {
          // 显式 OpenAI 兼容模式：直接按 /v1/models 列表解析
          const adapted = normalizeOpenAiModels(raw, sourceUrl);
          if (adapted) parsed = ModelSourceSchema.safeParse(adapted);
        } else {
          // 默认 native：先按 ModelSourceSchema 解析，失败再自动探测 OpenAI 列表（向后兼容）
          parsed = ModelSourceSchema.safeParse(raw);
          if (!parsed.success) {
            const adapted = normalizeOpenAiModels(raw, sourceUrl);
            if (adapted) parsed = ModelSourceSchema.safeParse(adapted);
          }
        }
        if (!parsed || !parsed.success) {
          const detail =
            parsed && !parsed.success
              ? parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
              : '上游响应既不是 ModelSourceSchema，也不是 OpenAI 兼容的 /v1/models 列表';
          throw new Error(`上游响应校验失败：${detail}`);
        }
        const providers = parsed.data.providers.map(normalizeProvider);
        setSyncedProviders(providers);
        this.providerRepo.replaceSnapshot(providers);
        const modelCount = providers.reduce((n, p) => n + p.models.length, 0);
        this.logRepo.insert({
          occurredAt: Date.now(), status: 'success', attempt,
          message: `同步成功：${providers.length} 个 provider / ${modelCount} 个模型`,
          detail: { providerCount: providers.length, modelCount }, sourceUrl,
        });
        this.appendLogFile(`[success] attempt=${attempt} providers=${providers.length} models=${modelCount}`);
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        this.logRepo.insert({
          occurredAt: Date.now(), status: 'error', attempt,
          message: msg, detail: { phase: 'fetch_or_validate' }, sourceUrl,
        });
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
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
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
    } catch {
      /* 日志落盘失败不致命 */
    }
  }
}

/**
 * 适配 OpenAI 兼容的 /v1/models 响应（{ object:'list', data:[{ id }] }）为 ModelSourceSchema。
 * 这样常见的中继/网关（仅暴露 /v1/models）也能直接作为上游模型源。
 * 返回 null 表示不是该格式，交由主流程按校验错误上报。
 */
function normalizeOpenAiModels(raw: unknown, sourceUrl: string): unknown | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { object?: unknown; data?: unknown };
  if (obj.object !== 'list' || !Array.isArray(obj.data)) return null;
  const models = obj.data
    .filter(
      (m): m is { id: string } =>
        !!m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string',
    )
    .map((m) => ({ id: m.id, name: m.id }));
  if (models.length === 0) return null;

  // baseUrl = 上游 URL 的 origin + 去掉末级路径（/v1/models → /v1）
  let baseUrl = '';
  try {
    const u = new URL(sourceUrl);
    const p = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
    const idx = p.lastIndexOf('/');
    u.pathname = idx > 0 ? p.slice(0, idx) : '/';
    u.search = '';
    u.hash = '';
    baseUrl = u.toString();
  } catch {
    return null;
  }
  if (!baseUrl) return null;

  return {
    providers: [
      {
        id: 'openai-compatible',
        name: 'OpenAI 兼容上游',
        baseUrl,
        defaultModel: models[0]?.id ?? '',
        models,
      },
    ],
  };
}

function normalizeProvider(p: ModelSourceProvider): ProviderInfo {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    defaultModel: p.defaultModel ?? '',
    docsUrl: p.docsUrl ?? '',
    models: p.models.map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.capabilities ? {
        capabilities: {
          function_calling: m.capabilities.function_calling,
          context_window: m.capabilities.context_window,
        },
      } : {}),
      ...(m.limits ? { limits: { ...m.limits } } : {}),
    })) as ProviderModel[],
  };
}
