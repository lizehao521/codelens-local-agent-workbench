/**
 * 跨代 diff 证据表的 schema 与类型契约（diff 乙阶段）。
 *
 * 独立成文件的原因与 generation-evidence.schema.ts 相同：`schema.ts` 已达结构棘轮
 * 上限 606/606，新表 DDL 不得塞进去。由 `ensureDiffTable` 幂等 lazy 建表，不依赖
 * 启动迁移，也不改变 `EXPECTED_TABLE_COUNT`。
 *
 * 为什么新建表而不是复用 rsi_generation_evidence 的 diff_* 列（codelens exp169 Q5）：
 * 主表要保持窄行与幂等 upsert 稳定；diff 正文体积大、重建重试语义独立，独立演进
 * 不会污染 failure 的 upsert 路径。主表那四列自此保留为默认值（'unavailable'/NULL），
 * 仅作为未来合并的余地，不作为读取源。
 *
 * 体积上限与状态值域均来自 codelens exp169 Q3/Q5：实现可更严，不可更宽。
 */

/** 表 DDL：由 ensureDiffTable 幂等执行。 */
export const RSI_DIFF_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rsi_generation_diff (
  policy_rsi_run_id  INTEGER PRIMARY KEY,
  session_id         TEXT    NOT NULL,
  generation         INTEGER NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'not_attempted'
                              CHECK (status IN ('complete','partial','unavailable','not_attempted')),
  aggregate_text     TEXT,
  text_bytes         INTEGER NOT NULL DEFAULT 0,
  text_truncated     INTEGER NOT NULL DEFAULT 0,
  events_json        TEXT,
  covered_writes     INTEGER NOT NULL DEFAULT 0,
  blind_spots_json   TEXT,
  invalid_args_count INTEGER NOT NULL DEFAULT 0,
  metadata_only      INTEGER NOT NULL DEFAULT 0,
  -- 丁阶段：本行 +/- 的来源。'checkpoint' = workspace_checkpoints.diff_json 真值；
  -- NULL/'tool_calls' = 乙阶段从 args_json 重建（老行 NULL 一律按 tool_calls 读）。
  origin             TEXT,
  source_window_t0   INTEGER,
  source_window_t1   INTEGER,
  schema_version     INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rsi_gdiff_session_gen
  ON rsi_generation_diff(session_id, generation DESC);
`;

/** 与主证据表同值域，另加 not_attempted（窗口不可用时不启动采集）。 */
export type DiffStatus = 'complete' | 'partial' | 'unavailable' | 'not_attempted';

/**
 * 单个写操作的重建结果。
 *
 * `note` 的取值是审计可读的固定枚举：
 *   empty_content / same_write / unreconstructable:overwrite / metadata_only /
 *   invalid_args_truncated
 */
export interface DiffEvent {
  readonly callId: string;
  readonly path: string | null;
  readonly op: string;
  /** 该事件贡献的有效 + 行数（0 = 未贡献，原因见 note）。 */
  readonly plus: number;
  readonly minus: number;
  readonly reconstructable: boolean;
  readonly note?: string;
}

export interface DiffEvidence {
  readonly status: DiffStatus;
  readonly source: 'tool_calls' | 'checkpoint' | null;
  readonly window: { readonly t0: number | null; readonly t1: number | null };
  /** 各可重建块拼接后的 unified 风格文本；不可重建块只留边界头。 */
  readonly aggregateText: string;
  readonly textBytes: number;
  readonly textTruncated: boolean;
  readonly events: readonly DiffEvent[];
  /** 被精确重建的写调用数（create/append/replace 且参数可解析）。 */
  readonly coveredWrites: number;
  /** 盲区标签：sys_exec:node / sys_exec:git / mcp:<name> / overwrite / delete / purge / rename / unknown:<name>。 */
  readonly blindSpots: readonly string[];
  readonly invalidArgsCount: number;
  /** 同代只有 rename/delete 这类元事件、无任何正文变更。 */
  readonly metadataOnly: boolean;
  /**
   * 丁阶段：可确证的增删行合计（checkpoint 路径专用）。
   * null/缺省 = 未知（tool_calls 路径由 aggregate_text 判定），
   * 0 = 快照确认零变更；>0 = 真实变更。二进制/大文件使该值不可信时置 null。
   */
  readonly changedLines?: number | null;
}

/** 硬上限（codelens Q5）：实现可更严，不可更宽。 */
export const DIFF_LIMITS = {
  /** 单代 aggregate_text 上限 256 KiB（UTF-8 字节）。 */
  aggregateBytes: 256 * 1024,
  /** 单代事件条数上限（超出仅保留计数，不再重建）。 */
  maxEvents: 200,
  /** detail 内 diffGuard 的硬预算（字符）。 */
  guardBytes: 128,
} as const;

/** ensure 需要的最小 DB 表面（与 EvidenceDb 同形，避免导入环）。 */
export interface DiffDb {
  exec(sql: string): void;
  run(sql: string, params?: unknown): unknown;
  get<T>(sql: string, params?: unknown): T | undefined;
  all<T>(sql: string, params?: unknown): T[];
}

const ensured = new WeakSet<object>();

/** 运行时能力检测：与 canWrite 同规则，缺任一方法直接降级。 */
export function canWriteDiff(db: DiffDb): boolean {
  return (
    typeof db.exec === 'function' &&
    typeof db.run === 'function' &&
    typeof db.get === 'function' &&
    typeof db.all === 'function'
  );
}

/** 幂等建表。首次调用后同连接不再执行。 */
export function ensureDiffTable(db: DiffDb): void {
  if (ensured.has(db as unknown as object)) return;
  db.exec(RSI_DIFF_SCHEMA_SQL);
  // 丁阶段：CREATE TABLE IF NOT EXISTS 不会给旧库补 origin 列，故按 PRAGMA 幂等补。
  // 只加一列（不建表、不加索引），失败由调用方的 try/catch 吸收。
  try {
    const cols = db.all<{ name: string }>(
      `SELECT name FROM pragma_table_info('rsi_generation_diff') WHERE name = 'origin'`,
    );
    if (cols.length === 0) db.exec('ALTER TABLE rsi_generation_diff ADD COLUMN origin TEXT');
  } catch {
    /* 旧库/受限连接：保持 NULL 语义即可 */
  }
  ensured.add(db as unknown as object);
}
