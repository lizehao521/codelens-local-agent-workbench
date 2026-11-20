/**
 * 跨代证据表的 schema 与类型契约（failure 第一阶段）。
 *
 * 独立成文件的原因：`schema.ts` 已达结构棘轮上限 606/606，新表 DDL 不得再塞进去。
 * 由 `ensureEvidenceTable` 幂等 lazy 建表（`CREATE TABLE IF NOT EXISTS`），因此
 * 不依赖启动时迁移，也不改变 `EXPECTED_TABLE_COUNT`（health 用 `>=` 判定，不破）。
 *
 * 体积上限来自 codelens exp168 Q3：实现可更严，不可更宽。
 */

/** 表 DDL：由 ensureEvidenceTable 幂等执行。 */
export const RSI_EVIDENCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rsi_generation_evidence (
  policy_rsi_run_id  INTEGER PRIMARY KEY,
  judge_run_id       INTEGER NOT NULL,
  session_id         TEXT    NOT NULL,
  generation         INTEGER NOT NULL,
  diff_status        TEXT    NOT NULL DEFAULT 'unavailable'
                              CHECK (diff_status IN ('complete','partial','unavailable','ambiguous')),
  failure_status     TEXT    NOT NULL DEFAULT 'unavailable'
                              CHECK (failure_status IN ('complete','partial','unavailable','ambiguous')),
  diff_source        TEXT,
  failure_source     TEXT,
  diff_json          TEXT,
  failure_json       TEXT,
  diff_truncated     INTEGER NOT NULL DEFAULT 0,
  failure_truncated  INTEGER NOT NULL DEFAULT 0,
  window_t0          INTEGER,
  window_t1          INTEGER,
  counts_json        TEXT,
  schema_version     INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rsi_evidence_session_gen
  ON rsi_generation_evidence(session_id, generation DESC);
`;

export type EvidenceStatus = 'complete' | 'partial' | 'unavailable' | 'ambiguous';

/** 单条失败样本（已脱敏归一的 signature + 限额内的原文）。 */
export interface FailureSample {
  readonly toolName: string;
  /** 只收 failed/timeout/rejected；skipped 默认不计。 */
  readonly status: 'failed' | 'timeout' | 'rejected';
  readonly errorType: string | null;
  readonly message: string | null;
  /** normalizeFailureSignature 的输出，供 evaluateStall 判定 1 逐字比对。 */
  readonly signature: string;
}

export interface FailureEvidence {
  readonly status: EvidenceStatus;
  readonly source: 'tool_calls' | null;
  readonly window: { readonly t0: number | null; readonly t1: number | null };
  readonly failures: readonly FailureSample[];
  readonly counts: {
    readonly total: number;
    readonly captured: number;
    readonly omitted: number;
    readonly failed: number;
    readonly timeout: number;
    readonly rejected: number;
  };
  readonly truncated: boolean;
}

/** 硬上限（codelens Q3）：实现可更严，不可更宽。 */
export const EVIDENCE_LIMITS = {
  /** 单行 evidence JSON 总计 ≤ 256 KiB（本阶段 failure 单独用 ≤ 64 KiB）。 */
  failureBytes: 64 * 1024,
  /** 单条 failure message/raw ≤ 4 KiB。 */
  sampleBytes: 4 * 1024,
  /** 单代 failure 最多 100 条，超出仅保留计数。 */
  maxSamples: 100,
} as const;

/** ensure 需要的最小 DB 表面（与 MigrationDb 同形，避免导入环）。 */
export interface EvidenceDb {
  exec(sql: string): void;
  run(sql: string, params?: unknown): unknown;
  get<T>(sql: string, params?: unknown): T | undefined;
  all<T>(sql: string, params?: unknown): T[];
}

const ensured = new WeakSet<object>();

/**
 * 运行时能力检测：桥接层传入的 db 是精简类型（可能只有 get），采集需要 exec/run/all。
 * 缺任一方法时直接降级，不抛错 —— 调用方的 try/catch 之外再加一道闸。
 */
export function canWrite(db: EvidenceDb): boolean {
  return (
    typeof db.exec === 'function' &&
    typeof db.run === 'function' &&
    typeof db.get === 'function' &&
    typeof db.all === 'function'
  );
}

/** 幂等建表。首次调用后同连接不再执行（WeakSet 不阻 GC）。 */
export function ensureEvidenceTable(db: EvidenceDb): void {
  if (ensured.has(db as unknown as object)) return;
  db.exec(RSI_EVIDENCE_SCHEMA_SQL);
  ensured.add(db as unknown as object);
}
