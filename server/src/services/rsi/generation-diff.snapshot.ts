/**
 * diff 丁阶段：从 workspace_checkpoints 的两份清单/已存行级 diff 取真值。
 *
 * 边界（exp170/170b/170c 裁定）：
 *   - 只在 (window_t0, window_t1] 内取快照；锚点方案已否决（会把上一代纳进来）。
 *   - S 非空即整代择源：+/- 全部来自快照，tool_calls 只回填计数与盲区，绝不叠加。
 *   - 多 run 不静默合并：按「最后一条快照 created_at 最大」择一，并列取 run_id
 *     字典序最大者；其余 run 记 mixed，整代降 partial 且不得 emit INV-1。
 *   - 单文件 diff 达 8000 字符、二进制/大文件、diff_json 缺失 → 该代 partial。
 *   - 只读；任何异常返回 null，由调用方回退乙阶段。
 */
import type { DiffEvent, DiffEvidence } from './generation-diff.schema.js';
import { DIFF_LIMITS } from './generation-diff.schema.js';

const PER_FILE_CAP = 8000;
const BINARY_MARK = '[二进制或大文件';
const NO_RUN = '__no_run__';

interface SnapshotDb {
  all<T>(sql: string, params?: unknown): T[];
}

interface SnapshotRow {
  id: string;
  run_id: string | null;
  step: number | null;
  created_at: number;
  status: string;
  diff_json: string | null;
}

interface FileDiff {
  path: string;
  operation: string;
  added: number;
  removed: number;
  diff: string;
}

export interface SnapshotWriteCall {
  readonly path: string;
  readonly op: string;
}

export interface SnapshotCtx {
  readonly sessionId: string;
  readonly t0: number;
  readonly t1: number;
  /** fs.write 可解析出的目标路径（覆盖判定的分母）。 */
  readonly expectedPaths: readonly string[];
  /** 每个 fs.write 调用（含 overwrite/delete），用于 coveredWrites 计数。 */
  readonly writeCalls: readonly SnapshotWriteCall[];
  /** 已过滤掉 overwrite 的恒定盲区（sys_exec:* / mcp:* / unknown:*）。 */
  readonly blindSpots: readonly string[];
  readonly invalidArgsCount: number;
}

interface RunBucket {
  key: string;
  lastCreated: number;
  rows: SnapshotRow[];
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function parseDiffs(raw: string | null): FileDiff[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return null;
    return arr
      .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
      .filter((d) => typeof d.path === 'string' && d.path.length > 0)
      .map((d) => ({
        path: String(d.path),
        operation: typeof d.operation === 'string' ? d.operation : 'write',
        added: num(d.added),
        removed: num(d.removed),
        diff: typeof d.diff === 'string' ? d.diff : '',
      }));
  } catch {
    return null;
  }
}

/** 多 run 择一：最后快照时间最大者胜；并列取 run_id 字典序最大（约定，非时序推断）。 */
function pickWinner(buckets: RunBucket[]): RunBucket {
  return [...buckets].sort((a, b) => {
    if (a.lastCreated !== b.lastCreated) return b.lastCreated - a.lastCreated;
    return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
  })[0]!;
}

export function collectSnapshotEvidence(db: SnapshotDb, ctx: SnapshotCtx): DiffEvidence | null {
  try {
    if (typeof db?.all !== 'function') return null;
    const rows = db.all<SnapshotRow>(
      `SELECT id, run_id, step, created_at, status, diff_json
         FROM workspace_checkpoints
        WHERE session_id = ? AND created_at > ? AND created_at <= ?
        ORDER BY created_at ASC, step ASC, id ASC`,
      [ctx.sessionId, ctx.t0, ctx.t1],
    );
    if (rows.length === 0) return null;

    // 按 run 分桶（run_id 为空的快照单独一桶，仍参与 mixed 判定）。
    const buckets = new Map<string, RunBucket>();
    for (const row of rows) {
      const key = row.run_id ?? NO_RUN;
      const b = buckets.get(key) ?? { key, lastCreated: 0, rows: [] };
      b.rows.push(row);
      b.lastCreated = Math.max(b.lastCreated, row.created_at);
      buckets.set(key, b);
    }
    const mixed = buckets.size > 1;
    const winner = pickWinner([...buckets.values()]);

    // 同一 (step, path) 多次出现取 created_at 最大者（同时间取 id 较大者）。
    const chosen = new Map<string, { row: SnapshotRow; diff: FileDiff }>();
    const blind = new Set<string>(ctx.blindSpots);
    let missing = false;
    let binary = false;
    let perFileTruncated = false;
    for (const row of winner.rows) {
      const diffs = parseDiffs(row.diff_json);
      if (diffs === null) {
        // 活跃快照没有可用 diff：覆盖不可证，整代不得 complete。
        if (row.status !== 'pruned') missing = true;
        continue;
      }
      for (const d of diffs) {
        if (d.diff.startsWith(BINARY_MARK)) binary = true;
        if (d.diff.length >= PER_FILE_CAP) perFileTruncated = true;
        const key = `${row.step ?? ''}|${d.path}`;
        const prev = chosen.get(key);
        if (!prev || row.created_at >= prev.row.created_at) chosen.set(key, { row, diff: d });
      }
    }
    if (chosen.size === 0) return null;

    const paths = new Set([...chosen.values()].map((c) => c.diff.path));
    const expected = [...new Set(ctx.expectedPaths)];
    const covered = expected.length > 0 && expected.every((p) => paths.has(p));
    const complete = covered && !mixed && !missing && !binary && !perFileTruncated && ctx.invalidArgsCount === 0;
    if (mixed) blind.add('mixed_runs');
    if (missing) blind.add('missing_diff');
    if (binary) blind.add('binary_or_large');
    if (perFileTruncated) blind.add('diff_truncated');

    // 逐字聚合：头部只放可机械解析的短字段；正文受 256 KiB 总预算约束。
    const blocks: string[] = [];
    const events: DiffEvent[] = [];
    let changed = 0;
    let truncated = false;
    let bytes = 0;
    for (const { row, diff } of chosen.values()) {
      const op = diff.operation === 'create' ? 'create' : 'write';
      const header = `--- RSI-GEN path=${JSON.stringify(diff.path)} op=snapshot:${op} call=cp:${row.id}\n`;
      const body = diff.diff.length > 0 ? `${diff.diff}\n` : '# snapshot:empty\n';
      const add = Buffer.byteLength(header + body, 'utf8');
      if (bytes + add > DIFF_LIMITS.aggregateBytes || events.length >= DIFF_LIMITS.maxEvents) {
        truncated = true;
        break;
      }
      blocks.push(header, body);
      bytes += add;
      changed += diff.added + diff.removed;
      events.push({
        callId: `cp:${row.id}`,
        path: diff.path,
        op,
        plus: diff.added,
        minus: diff.removed,
        reconstructable: true,
      });
    }

    const aggregateText = blocks.join('');
    return {
      status: complete && !truncated ? 'complete' : 'partial',
      source: 'checkpoint',
      window: { t0: ctx.t0, t1: ctx.t1 },
      aggregateText,
      textBytes: Buffer.byteLength(aggregateText, 'utf8'),
      textTruncated: truncated,
      events,
      coveredWrites: ctx.writeCalls.filter((c) => paths.has(c.path)).length,
      blindSpots: [...blind],
      invalidArgsCount: ctx.invalidArgsCount,
      // rename/delete/purge 只动元信息或删全文，零行不能推出「无变更」，禁 emit。
      metadataOnly: ctx.writeCalls.some((c) => c.op === 'rename' || c.op === 'delete' || c.op === 'purge'),
      changedLines: binary || missing ? null : changed,
    };
  } catch {
    return null;
  }
}
