/**
 * 逐代 diff 证据的只读回读（codelens exp172 裁定）。
 *
 * 三条硬约束，均来自裁定原文：
 *   ① 不建表、不 ALTER、不 upsert —— 表缺失返回空，绝不 lazy ensure；
 *   ② 不补采历史代 —— 事后重建混入原表会改变分母与状态比例，等于伪证；
 *   ③ 不折叠状态 —— complete/partial/unavailable/not_attempted 必须可区分，
 *      连「complete 但被截断」也不能并入 complete。
 *
 * 与 loadGenerationDiff 的分工：后者面向 INV-1，只给「可消费的完整正文」；
 * 本模块面向统计，只给「持久化事实」，绝不读 aggregate_text。
 */
import type { DiffStatus } from './generation-diff.schema.js';

/** 只读所需的最小 DB 表面：故意不含 exec/run，写库在类型层就不可达。 */
export interface ReadbackDb {
  get<T>(sql: string, params?: unknown): T | undefined;
  all<T>(sql: string, params?: unknown): T[];
}

const STATUSES: ReadonlySet<string> = new Set<DiffStatus>([
  'complete',
  'partial',
  'unavailable',
  'not_attempted',
]);

const ORIGINS: ReadonlySet<string> = new Set(['tool_calls', 'checkpoint']);

/** 单代持久化统计行（不含正文）。 */
export interface GenerationDiffStat {
  readonly sessionId: string;
  readonly generation: number;
  readonly status: DiffStatus;
  readonly textBytes: number;
  readonly textTruncated: boolean;
  readonly coveredWrites: number;
  readonly invalidArgsCount: number;
  readonly metadataOnly: boolean;
  readonly origin: 'tool_calls' | 'checkpoint' | null;
  readonly window: { readonly t0: number | null; readonly t1: number | null };
  readonly blindSpotsCount: number;
}

/** 聚合摘要：只基于实际存在的行，不虚构 not_attempted。 */
export interface GenerationDiffSummary {
  readonly recordedGenerations: number;
  readonly completeCount: number;
  readonly partialCount: number;
  readonly unavailableCount: number;
  readonly notAttemptedCount: number;
  readonly truncatedCount: number;
  readonly metadataOnlyCount: number;
  readonly coveredWritesSum: number;
  readonly invalidArgsCountSum: number;
  readonly blindSpotsSum: number;
}

interface RawRow {
  readonly session_id: string;
  readonly generation: number;
  readonly status: string;
  readonly text_bytes: number | null;
  readonly text_truncated: number | null;
  readonly covered_writes: number | null;
  readonly invalid_args_count: number | null;
  readonly metadata_only: number | null;
  readonly origin: string | null;
  readonly source_window_t0: number | null;
  readonly source_window_t1: number | null;
  readonly blind_spots_json: string | null;
}

/** 表存在性只查 sqlite_master：不用 pragma、不触发任何隐式建表。 */
function hasTable(db: ReadbackDb): boolean {
  const row = db.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rsi_generation_diff'`,
  );
  return row !== undefined && row.name === 'rsi_generation_diff';
}

function bad(field: string, value: unknown): never {
  throw new Error(`rsi_generation_diff retread: invalid ${field}=${JSON.stringify(value)}`);
}

function asInt(field: string, v: number | null): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) bad(field, v);
  return v;
}

function asNullableInt(field: string, v: number | null): number | null {
  return v === null ? null : asInt(field, v);
}

/** NULL 视为空数组（0 个盲区）；非法 JSON 或非数组一律抛，不静默当 0。 */
function blindSpotsCount(raw: string | null): number {
  if (raw === null) return 0;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) bad('blind_spots_json', raw.slice(0, 40));
  return (parsed as unknown[]).length;
}

function mapRow(row: RawRow): GenerationDiffStat {
  if (!STATUSES.has(row.status)) bad('status', row.status);
  if (row.origin !== null && !ORIGINS.has(row.origin)) bad('origin', row.origin);
  return {
    sessionId: row.session_id,
    generation: asInt('generation', row.generation),
    status: row.status as DiffStatus,
    textBytes: asInt('text_bytes', row.text_bytes),
    textTruncated: asInt('text_truncated', row.text_truncated) !== 0,
    coveredWrites: asInt('covered_writes', row.covered_writes),
    invalidArgsCount: asInt('invalid_args_count', row.invalid_args_count),
    metadataOnly: asInt('metadata_only', row.metadata_only) !== 0,
    origin: row.origin as 'tool_calls' | 'checkpoint' | null,
    window: {
      t0: asNullableInt('source_window_t0', row.source_window_t0),
      t1: asNullableInt('source_window_t1', row.source_window_t1),
    },
    blindSpotsCount: blindSpotsCount(row.blind_spots_json),
  };
}

const SELECT_COLS = `session_id, generation, status, text_bytes, text_truncated,
  covered_writes, invalid_args_count, metadata_only, origin,
  source_window_t0, source_window_t1, blind_spots_json`;

/**
 * 某会话全部持久化逐代统计行，严格按 generation 升序。
 * 表不存在 → []（不建表）；表存在但查询失败 → 抛（不把故障伪装成「未采集」）。
 */
export function readGenerationDiffStats(db: ReadbackDb, sessionId: string): GenerationDiffStat[] {
  if (!hasTable(db)) return [];
  const rows = db.all<RawRow>(
    `SELECT ${SELECT_COLS} FROM rsi_generation_diff WHERE session_id = ? ORDER BY generation ASC`,
    [sessionId],
  );
  return rows.map(mapRow);
}

/** 指定代；无行返回 null（不虚构 not_attempted）。 */
export function readGenerationDiffStat(
  db: ReadbackDb,
  sessionId: string,
  generation: number,
): GenerationDiffStat | null {
  if (!hasTable(db)) return null;
  const row = db.get<RawRow>(
    `SELECT ${SELECT_COLS} FROM rsi_generation_diff
      WHERE session_id = ? AND generation = ? LIMIT 1`,
    [sessionId, generation],
  );
  return row === undefined ? null : mapRow(row);
}

/** 纯函数聚合：与 SQL 侧 SUM(status='x') 逐字段同义。 */
export function summarizeGenerationDiffStats(
  rows: readonly GenerationDiffStat[],
): GenerationDiffSummary {
  let complete = 0;
  let partial = 0;
  let unavailable = 0;
  let notAttempted = 0;
  let truncated = 0;
  let metadataOnly = 0;
  let covered = 0;
  let invalidArgs = 0;
  let blind = 0;
  for (const r of rows) {
    if (r.status === 'complete') complete += 1;
    else if (r.status === 'partial') partial += 1;
    else if (r.status === 'unavailable') unavailable += 1;
    else notAttempted += 1;
    if (r.textTruncated) truncated += 1;
    if (r.metadataOnly) metadataOnly += 1;
    covered += r.coveredWrites;
    invalidArgs += r.invalidArgsCount;
    blind += r.blindSpotsCount;
  }
  return {
    recordedGenerations: rows.length,
    completeCount: complete,
    partialCount: partial,
    unavailableCount: unavailable,
    notAttemptedCount: notAttempted,
    truncatedCount: truncated,
    metadataOnlyCount: metadataOnly,
    coveredWritesSum: covered,
    invalidArgsCountSum: invalidArgs,
    blindSpotsSum: blind,
  };
}
