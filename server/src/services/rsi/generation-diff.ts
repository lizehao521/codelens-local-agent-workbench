/**
 * 跨代 diff 证据采集（乙：tool_calls 重建；丁：checkpoint 真值，满足充要条件才 emit INV-1）。
 *
 * 数据源：tool_calls.args_json 的操作级重建（codelens exp169 裁定的乙路）。
 * 不改任何写入侧、不改 agent-loop —— fs.write 的参数本来就落库。
 *
 * ★本模块的诚实边界（务必与调用方一起阅读）：
 *   - 只有 create / append / replace 能重建出逐字 +/- 行（见 generation-diff.build.ts）；
 *     overwrite 一律降级 partial，delete/purge/rename 只记元事件。
 *   - sys.exec 白名单含 node/git、MCP 参数不透明 → 盲区，永不判 complete。
 *   - args_json 超过 8192 字符会被 slice 成非法 JSON → 整代 unavailable，而非 partial。
 *
 * 判定合取语义（Q2）：zeroDiff 只对「全代合计」成立 —— 所有可重建块剥离注释/空白
 * 后均无有效行，且不存在任何未覆盖写通道。单文件为零不推出全代为零。
 */
import { isZeroEffectiveDiff } from './cross-generation-stall.js';
import { loadCurrentRun, loadGenerationAnchor, hasOverlappingGeneration } from './generation-evidence.js';
import type { EvidenceDb } from './generation-evidence.schema.js';
import {
  DIFF_LIMITS,
  canWriteDiff,
  ensureDiffTable,
  type DiffEvidence,
  type DiffStatus,
} from './generation-diff.schema.js';
import { collectSnapshotEvidence } from './generation-diff.snapshot.js';
import {
  EXEC_TOOLS,
  WRITE_TOOLS,
  addBlock,
  createAcc,
  handleWrite,
  parseArgs,
  resolveStatus,
  type ToolCallRow,
} from './generation-diff.build.js';

export type { DiffEvidence, DiffEvent, DiffStatus } from './generation-diff.schema.js';

const EMPTY: DiffEvidence = {
  status: 'not_attempted',
  source: null,
  window: { t0: null, t1: null },
  aggregateText: '',
  textBytes: 0,
  textTruncated: false,
  events: [],
  coveredWrites: 0,
  blindSpots: [],
  invalidArgsCount: 0,
  metadataOnly: false,
};

/**
 * 采集当前代 diff 证据（只读 + 幂等 upsert）。永不抛错。
 *
 * 窗口与 failure 完全同源（同一 t0/t1 语义），避免两套归属规则分叉。
 */
export function collectDiffEvidence(
  db: EvidenceDb,
  sessionId: string,
): DiffEvidence {
  try {
    if (!canWriteDiff(db)) return EMPTY;
    ensureDiffTable(db);
    const current = loadCurrentRun(db, sessionId);
    if (!current) return EMPTY;

    const t1 = loadGenerationAnchor(db, sessionId, current.generation);
    const t0 = loadGenerationAnchor(db, sessionId, current.generation - 1);
    if (t0 === null || t1 === null) return { ...EMPTY, status: 'unavailable', window: { t0, t1 } };
    if (t0 >= t1 || hasOverlappingGeneration(db, sessionId, current.generation, t0, t1)) {
      return { ...EMPTY, status: 'unavailable', window: { t0, t1 } };
    }

    const rows = db.all<ToolCallRow>(
      `SELECT id, call_id, tool_name, tool_wire_name, category, source, status, args_json, created_at
         FROM tool_calls
        WHERE session_id = ? AND created_at > ? AND created_at <= ?
        ORDER BY created_at ASC, id ASC`,
      [sessionId, t0, t1],
    );

    const acc = createAcc();
    for (const row of rows) {
      // MCP 参数不透明：一律盲区，不尝试解析。
      if (row.source === 'mcp') {
        acc.blindSpots.push(`mcp:${row.tool_name}`);
        continue;
      }
      if (EXEC_TOOLS.has(row.tool_name) || EXEC_TOOLS.has(row.tool_wire_name)) {
        const args = parseArgs(row.args_json);
        const cmd = typeof args?.command === 'string' ? args.command : '';
        // codelens exp169 Q3：任何 sys.exec 都保守降级 —— 无法证明该调用未写文件
        // （node -e / git apply 均可改工作区）。标签保留命令名供审计定位。
        acc.blindSpots.push(`sys_exec:${cmd}`);
        continue;
      }
      if (WRITE_TOOLS.has(row.tool_name) || WRITE_TOOLS.has(row.tool_wire_name)) {
        if (acc.events.length >= DIFF_LIMITS.maxEvents) {
          acc.truncated = true;
          continue;
        }
        handleWrite(acc, row);
      }
    }

    const aggregateText = acc.blocks.join('');
    const base: DiffEvidence = {
      status: resolveStatus(acc),
      source: 'tool_calls',
      window: { t0, t1 },
      aggregateText,
      textBytes: Buffer.byteLength(aggregateText, 'utf8'),
      textTruncated: acc.truncated,
      events: acc.events,
      coveredWrites: acc.coveredWrites,
      blindSpots: [...new Set(acc.blindSpots)],
      invalidArgsCount: acc.invalidArgs,
      metadataOnly: acc.metadataOnly,
    };
    // diff 丁阶段：同窗口存在快照真值时整代择源（+/- 全部来自 diff_json，
    // tool_calls 只回填计数与盲区）。快照不可用则原样回退乙，数值零变化。
    const writeCalls = acc.events
      .filter((e) => typeof e.path === 'string' && e.path.length > 0)
      .map((e) => ({ path: String(e.path), op: e.op }));
    const expectedPaths = writeCalls
      .filter((c) => c.op !== 'delete' && c.op !== 'purge' && c.op !== 'rename')
      .map((c) => c.path);
    // 快照能覆盖 fs.write 全操作，故 overwrite/delete 等乙盲区标签在丁路径下不再成立；
    // 只保留与写入无关的恒定盲区（sys.exec / MCP / 未知操作）。
    const persistentBlind = acc.blindSpots.filter(
      (b) => b.startsWith('sys_exec:') || b.startsWith('mcp:') || b.startsWith('unknown'),
    );
    const snap = collectSnapshotEvidence(db, {
      sessionId, t0, t1, expectedPaths, writeCalls,
      blindSpots: persistentBlind, invalidArgsCount: acc.invalidArgs,
    });
    if (snap !== null) return snap;
    return base;
  } catch {
    return EMPTY;
  }
}

/** 幂等落库：同一 policy_rsi_run_id 覆盖同一版本。 */
export function upsertDiffEvidence(
  db: EvidenceDb,
  sessionId: string,
  evidence: DiffEvidence,
  now: number = Date.now(),
): void {
  try {
    if (!canWriteDiff(db)) return;
    ensureDiffTable(db);
    const current = loadCurrentRun(db, sessionId);
    if (!current) return;
    db.run(
      `INSERT INTO rsi_generation_diff
         (policy_rsi_run_id, session_id, generation, status, aggregate_text, text_bytes,
          text_truncated, events_json, covered_writes, blind_spots_json, invalid_args_count,
          metadata_only, origin, source_window_t0, source_window_t1, schema_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(policy_rsi_run_id) DO UPDATE SET
         status = excluded.status,
         aggregate_text = excluded.aggregate_text,
         text_bytes = excluded.text_bytes,
         text_truncated = excluded.text_truncated,
         events_json = excluded.events_json,
         covered_writes = excluded.covered_writes,
         blind_spots_json = excluded.blind_spots_json,
         invalid_args_count = excluded.invalid_args_count,
         metadata_only = excluded.metadata_only,
         origin = excluded.origin,
         source_window_t0 = excluded.source_window_t0,
         source_window_t1 = excluded.source_window_t1,
         updated_at = excluded.updated_at`,
      [
        current.id, sessionId, current.generation, evidence.status,
        evidence.aggregateText.length > 0 ? evidence.aggregateText : null,
        evidence.textBytes, evidence.textTruncated ? 1 : 0,
        JSON.stringify(evidence.events), evidence.coveredWrites,
        JSON.stringify(evidence.blindSpots), evidence.invalidArgsCount,
        evidence.metadataOnly ? 1 : 0,
        evidence.source,
        evidence.window.t0, evidence.window.t1, now, now,
      ],
    );
  } catch {
    /* 静默降级：审计旁路不得影响主流程 */
  }
}

/** 读取指定代的 diff 证据；仅 complete 且未截断才返回可判文本，其余返回 null。 */
export function loadGenerationDiff(
  db: EvidenceDb,
  sessionId: string,
  generation: number,
): { readonly status: DiffStatus; readonly diffText: string } | null {
  try {
    if (!canWriteDiff(db)) return null;
    ensureDiffTable(db);
    const row = db.get<{ status: string; aggregate_text: string | null; text_truncated: number }>(
      `SELECT status, aggregate_text, text_truncated FROM rsi_generation_diff
        WHERE session_id = ? AND generation = ? LIMIT 1`,
      [sessionId, generation],
    );
    if (!row) return null;
    // 只有 complete 且未截断才可作为零变更判据（partial 的"零"不可信）。
    if (row.status !== 'complete' || row.text_truncated !== 0) return null;
    return { status: 'complete', diffText: row.aggregate_text ?? '' };
  } catch {
    return null;
  }
}

/** detail 内紧凑守卫（codelens Q6）：只放短枚举与计数，绝不放 diff 正文。 */
export interface DiffGuard {
  readonly s: DiffStatus;
  readonly cw: number;
  readonly bi: number;
  readonly ia: number;
  readonly tr: 0 | 1;
  /** 仅 status=complete 时存在：全代是否零有效变更。 */
  readonly z?: 0 | 1;
  /** 仅 status=complete 时存在：是否具备报 INV-1 矛盾的必要条件（丁阶段由视图侧 emit）。 */
  readonly el?: 0 | 1;
  readonly tb?: number;
}

/**
 * 构建 detail 用守卫。z/el 仅在 complete 时给出 —— 不可判时省略而非置 0，
 * 否则「没看见」会被读成「非零变更」，与 consistent 护栏同源。
 */
export function buildDiffGuard(evidence: DiffEvidence, verdict: string): DiffGuard {
  // 丁路径有 added/removed 真值时不解析文本：8KB 截断只丢展示，不丢计数。
  const zero = evidence.status === 'complete'
    ? (evidence.changedLines !== undefined && evidence.changedLines !== null
      ? evidence.changedLines === 0
      : isZeroEffectiveDiff({ diffText: evidence.aggregateText }))
    : null;
  const eligible =
    evidence.status === 'complete' &&
    verdict === 'improved' &&
    zero === true &&
    evidence.coveredWrites > 0 &&
    !evidence.metadataOnly;
  const base: Record<string, number | string> = {
    s: evidence.status,
    cw: evidence.coveredWrites,
    bi: evidence.blindSpots.length,
    ia: evidence.invalidArgsCount,
    tr: evidence.textTruncated ? 1 : 0,
  };
  if (zero !== null) {
    base.z = zero ? 1 : 0;
    base.el = eligible ? 1 : 0;
  }
  base.tb = evidence.textBytes;
  // 128 字符预算：先省 tb，再省 el（s/tr/ia/z 为不可省的最小集）。
  let out = base;
  if (JSON.stringify(out).length > DIFF_LIMITS.guardBytes) {
    const { tb: _tb, ...noTb } = out;
    out = noTb;
    if (JSON.stringify(out).length > DIFF_LIMITS.guardBytes) {
      const { el: _el, ...noEl } = out;
      out = noEl;
    }
  }
  return out as unknown as DiffGuard;
}

/**
 * INV-1 正式 emit 的充要条件（exp170 Q6，实现取更严口径）。
 *
 * 比裁定多要求 blindSpots 为空：只要存在 sys.exec/MCP 等不可观测写通道，
 * 「快照说零变更」就不能升级为「全代零变更」——否则正是「没看见」洗成「没改」。
 * 这说明丁的 emit 在真实代际里仍会稀发，但不会假阳性。
 */
export function isInv1Eligible(evidence: DiffEvidence, verdict: string): boolean {
  return (
    evidence.status === 'complete' &&
    evidence.source === 'checkpoint' &&
    evidence.changedLines === 0 &&
    evidence.coveredWrites > 0 &&
    !evidence.metadataOnly &&
    evidence.invalidArgsCount === 0 &&
    evidence.blindSpots.length === 0 &&
    verdict === 'improved'
  );
}
