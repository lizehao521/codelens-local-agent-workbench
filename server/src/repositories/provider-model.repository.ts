/** Upstream model-sync persistence: success snapshot + sync status/exception log. */

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

/** 最近一次成功同步的 provider 快照（整体覆盖，保证与上游一致）。 */
export class ProviderModelRepository {
  constructor(private readonly db: Db) {}

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

  /** 重建最近一次成功快照为 ProviderInfo[]（重启后首拉前的兜底合并）。 */
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
        defaultModel: r.default_model, docsUrl: r.docs_url, models: [],
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

/** 每次同步尝试的状态/异常记录（成功/失败/禁用）。 */
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
