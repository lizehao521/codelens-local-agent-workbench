/**
 * 跨代证据采集（failure 第一阶段）。
 *
 * 职责：从 tool_calls 只读重建每代的失败样本，幂等落 `rsi_generation_evidence`，
 * 供 consistency 的 evaluateStall 判定 1（signature_repeated）消费。
 *
 * 裁定来源：codelens exp168（选型）+ exp168b（方向纠偏）。范围边界（硬约束）：
 *   - 只做 failure；diff 留待乙（tool_calls 操作级）/丁（fs.write 边界旁路）阶段。
 *   - INV-2 明确剔出本轮：其前置是 rollback 构造，failure 对 `!stalled` 是负向，
 *     绝不宣称解锁 INV-2。受益者是 INV-3（warning 多一条触发路径）。
 *   - 不改 agent-loop（upstream 1550/1550 顶格）、不改 schema.ts（606/606 顶格）。
 *   - 不回填历史代；旧代 evidence 恒缺行，消费侧按 unavailable 处理。
 *
 * 误配防御（codelens Q2 六条件）：session_id 精确相等；judge_run_id 与当前 policy
 * 行绑定；窗口 (t0,t1] 两端同链，缺 t0 不猜界；查询固定快照 + 确定性排序；重叠
 * 代窗/并发 run/t0>=t1 → ambiguous；多会话不合并。
 */
import type { FailureInput } from './cross-generation-stall.js';
import { normalizeFailureSignature } from './cross-generation-stall.js';
import {
  EVIDENCE_LIMITS,
  canWrite,
  ensureEvidenceTable,
  type EvidenceDb,
  type FailureEvidence,
  type FailureSample,
} from './generation-evidence.schema.js';

export type { EvidenceDb, FailureEvidence, FailureSample } from './generation-evidence.schema.js';

/** 当前代行（由 session 内最新代定位；recordShadowAudit 调用时该行已落库）。 */
export interface CurrentRunRow {
  readonly id: number;
  readonly generation: number;
  readonly judge_run_id: number;
}

export function loadCurrentRun(db: EvidenceDb, sessionId: string): CurrentRunRow | undefined {
  return db.get<CurrentRunRow>(
    `SELECT id, generation, judge_run_id FROM policy_rsi_runs
      WHERE session_id = ? ORDER BY generation DESC LIMIT 1`,
    [sessionId],
  );
}

/** 指定代的 judge_run.created_at；代行或 judge 行缺失时返回 null。 */
export function loadGenerationAnchor(db: EvidenceDb, sessionId: string, generation: number): number | null {
  if (generation <= 0) return null;
  const row = db.get<{ created_at: number | null }>(
    `SELECT j.created_at AS created_at
       FROM policy_rsi_runs p JOIN judge_runs j ON j.id = p.judge_run_id
      WHERE p.session_id = ? AND p.generation = ? LIMIT 1`,
    [sessionId, generation],
  );
  return row?.created_at ?? null;
}

/** 窗口内是否夹了别的代（重叠/并发 → 归属不唯一）。 */
export function hasOverlappingGeneration(
  db: EvidenceDb,
  sessionId: string,
  generation: number,
  t0: number,
  t1: number,
): boolean {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM policy_rsi_runs p JOIN judge_runs j ON j.id = p.judge_run_id
      WHERE p.session_id = ? AND p.generation <> ?
        AND j.created_at > ? AND j.created_at <= ?`,
    [sessionId, generation, t0, t1],
  );
  return (row?.n ?? 0) > 0;
}

interface ToolCallRow {
  tool_name: string;
  status: string;
  error_kind: string | null;
  error_msg: string | null;
  result_summary: string | null;
  created_at: number;
}

/** 按字节上限切串（UTF-8 安全：退到码点边界）。 */
function clampBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

const FAILURE_STATUSES = new Set(['failed', 'timeout', 'rejected']);

const EMPTY: FailureEvidence = {
  status: 'unavailable',
  source: null,
  window: { t0: null, t1: null },
  failures: [],
  counts: { total: 0, captured: 0, omitted: 0, failed: 0, timeout: 0, rejected: 0 },
  truncated: false,
};

/**
 * 采集当前代失败证据（只读）。永不抛错：任何内部异常降级为 status='unavailable'。
 *
 * @param now 保留给调用方注入（当前未参与窗口计算，窗口只取 judge 锚点）
 */
export function collectFailureEvidence(
  db: EvidenceDb,
  sessionId: string,
  now: number = Date.now(),
): FailureEvidence {
  void now;
  try {
    if (!canWrite(db)) return EMPTY;
    ensureEvidenceTable(db);
    const current = loadCurrentRun(db, sessionId);
    if (!current) return EMPTY;

    const t1 = loadGenerationAnchor(db, sessionId, current.generation);
    const t0 = loadGenerationAnchor(db, sessionId, current.generation - 1);
    // 缺 t0（首代/前代无 judge 行）→ 不得跨代猜界 → unavailable（codelens Q2-3）。
    if (t0 === null || t1 === null) return { ...EMPTY, window: { t0, t1 } };
    // t0>=t1（时钟异常/同毫秒并发）→ 窗口不可信。
    if (t0 >= t1) return { ...EMPTY, status: 'ambiguous', window: { t0, t1 } };
    // 窗口内夹了别的代 → 归属不唯一。
    if (hasOverlappingGeneration(db, sessionId, current.generation, t0, t1)) {
      return { ...EMPTY, status: 'ambiguous', window: { t0, t1 } };
    }

    const rows = db.all<ToolCallRow>(
      `SELECT tool_name, status, error_kind, error_msg, result_summary, created_at
         FROM tool_calls
        WHERE session_id = ? AND created_at > ? AND created_at <= ?
        ORDER BY created_at ASC, id ASC`,
      [sessionId, t0, t1],
    );

    const counts = { total: 0, captured: 0, omitted: 0, failed: 0, timeout: 0, rejected: 0 };
    const failures: FailureSample[] = [];
    let truncated = false;

    for (const row of rows) {
      if (!FAILURE_STATUSES.has(row.status)) continue;
      counts.total += 1;
      if (row.status === 'failed') counts.failed += 1;
      else if (row.status === 'timeout') counts.timeout += 1;
      else counts.rejected += 1;

      if (failures.length >= EVIDENCE_LIMITS.maxSamples) {
        counts.omitted += 1;
        truncated = true;
        continue;
      }
      const raw = [row.tool_name, row.status, row.error_kind ?? '', row.error_msg ?? row.result_summary ?? '']
        .filter((s) => s.length > 0)
        .join(' | ');
      const clamped = clampBytes(raw, EVIDENCE_LIMITS.sampleBytes);
      if (clamped.truncated) truncated = true;
      const message = clampBytes(row.error_msg ?? row.result_summary ?? '', EVIDENCE_LIMITS.sampleBytes);
      if (message.truncated) truncated = true;

      const input: FailureInput = {
        rawText: clamped.text,
        ...(row.error_kind !== null && row.error_kind.length > 0 ? { errorType: row.error_kind } : {}),
        ...(message.text.length > 0 ? { message: message.text } : {}),
      };
      failures.push({
        toolName: row.tool_name,
        status: row.status as FailureSample['status'],
        errorType: row.error_kind,
        message: message.text.length > 0 ? message.text : null,
        signature: normalizeFailureSignature(input),
      });
      counts.captured += 1;
    }

    // 总量超 64 KiB → 从尾部裁剪样本，只保计数（确定性：保留靠前的）。
    let currentBytes = Buffer.byteLength(JSON.stringify(failures), 'utf8');
    while (currentBytes > EVIDENCE_LIMITS.failureBytes && failures.length > 0) {
      failures.pop();
      counts.omitted += 1;
      truncated = true;
      currentBytes = Buffer.byteLength(JSON.stringify(failures), 'utf8');
    }

    return {
      status: truncated ? 'partial' : 'complete',
      source: 'tool_calls',
      window: { t0, t1 },
      failures,
      counts,
      truncated,
    };
  } catch {
    return EMPTY;
  }
}

/** 幂等落库：同一 policy_rsi_run_id 重跑覆盖同一版本，不追加矛盾证据。 */
export function upsertFailureEvidence(
  db: EvidenceDb,
  sessionId: string,
  evidence: FailureEvidence,
  now: number = Date.now(),
): CurrentRunRow | null {
  try {
    if (!canWrite(db)) return null;
    ensureEvidenceTable(db);
    const current = loadCurrentRun(db, sessionId);
    if (!current) return null;
    const json = evidence.failures.length > 0 ? JSON.stringify(evidence) : null;
    db.run(
      `INSERT INTO rsi_generation_evidence
         (policy_rsi_run_id, judge_run_id, session_id, generation,
          diff_status, failure_status, diff_source, failure_source,
          diff_json, failure_json, diff_truncated, failure_truncated,
          window_t0, window_t1, counts_json, schema_version, created_at)
       VALUES (?, ?, ?, ?, 'unavailable', ?, NULL, ?, NULL, ?, 0, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(policy_rsi_run_id) DO UPDATE SET
         failure_status = excluded.failure_status,
         failure_source = excluded.failure_source,
         failure_json   = excluded.failure_json,
         failure_truncated = excluded.failure_truncated,
         window_t0 = excluded.window_t0,
         window_t1 = excluded.window_t1,
         counts_json = excluded.counts_json,
         created_at = excluded.created_at`,
      [
        current.id,
        current.judge_run_id,
        sessionId,
        current.generation,
        evidence.status,
        evidence.source,
        json,
        evidence.truncated ? 1 : 0,
        evidence.window.t0,
        evidence.window.t1,
        JSON.stringify(evidence.counts),
        now,
      ],
    );
    return current;
  } catch {
    return null;
  }
}

/**
 * 读取指定代的失败证据，映射为 GenerationRecord.failure 的输入。
 *
 * 语义：判定 1 比对的是「整代失败签名集合」，而非单条失败。故把该代全部签名
 * 去重排序后拼成一段稳定文本作为 rawText —— 集合相同则归一结果相同，集合有差
 * 则必然不同。normalizeFailureSignature 的各级归一（redact/路径/行号/版本/空白）
 * 对已归一文本幂等，二次归一不改变结果。
 *
 * 只有 status='complete'/'partial' 且有样本时才返回；ambiguous/unavailable
 * 一律返回 null —— 消费侧因此不会把「归属不明」当作「无失败」。
 */
export function loadGenerationFailure(
  db: EvidenceDb,
  sessionId: string,
  generation: number,
): FailureInput | null {
  try {
    if (!canWrite(db)) return null;
    ensureEvidenceTable(db);
    const row = db.get<{ failure_status: string; failure_json: string | null }>(
      `SELECT failure_status, failure_json FROM rsi_generation_evidence
        WHERE session_id = ? AND generation = ? LIMIT 1`,
      [sessionId, generation],
    );
    if (!row || row.failure_json === null) return null;
    if (row.failure_status !== 'complete' && row.failure_status !== 'partial') return null;
    const parsed = JSON.parse(row.failure_json) as FailureEvidence;
    if (parsed.failures.length === 0) return null;
    const merged = [...new Set(parsed.failures.map((f) => f.signature))].sort().join('\n');
    return { rawText: merged };
  } catch {
    return null;
  }
}
