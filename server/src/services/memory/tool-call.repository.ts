/** Tool-call repository: append-only audit rows (first-class citizens, AC-03/AC-06). */

import type { Db } from '../../repositories/db.js';
import { newUuid } from '../../utils/hash.js';

export type ToolCallStatus =
  | 'pending' | 'running' | 'success' | 'failed' | 'timeout' | 'rejected' | 'skipped';

export interface ToolCallRow {
  id: string;
  session_id: string;
  message_id: string | null;
  call_id: string;
  tool_name: string;
  tool_wire_name: string;
  display_name: string;
  category: string;
  source: string;
  risk: string;
  approval_mode: string;
  channel: string;
  iteration: number;
  args_json: string;
  args_digest: string | null;
  status: ToolCallStatus;
  error_kind: string | null;
  error_msg: string | null;
  result_ref: string | null;
  result_summary: string | null;
  truncated: number;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number;
  created_at: number;
}

export interface InsertToolCallInput {
  sessionId: string;
  messageId: string | null;
  callId: string;
  toolName: string;
  toolWireName: string;
  displayName: string;
  category: string;
  source: string;
  risk: string;
  approvalMode: string;
  channel: 'native' | 'react';
  iteration: number;
  argsJson: string;
  argsDigest: string;
}

const MAX_ARGS_CHARS = 8192;

export class ToolCallRepository {
  constructor(private readonly db: Db) {}

  insert(input: InsertToolCallInput): ToolCallRow {
    const now = Date.now();
    const row: ToolCallRow = {
      id: newUuid(),
      session_id: input.sessionId,
      message_id: input.messageId,
      call_id: input.callId,
      tool_name: input.toolName,
      tool_wire_name: input.toolWireName,
      display_name: input.displayName,
      category: input.category,
      source: input.source,
      risk: input.risk,
      approval_mode: input.approvalMode,
      channel: input.channel,
      iteration: input.iteration,
      args_json:
        input.argsJson.length > MAX_ARGS_CHARS
          ? `${input.argsJson.slice(0, MAX_ARGS_CHARS)}…[truncated]`
          : input.argsJson,
      args_digest: input.argsDigest,
      status: 'pending',
      error_kind: null,
      error_msg: null,
      result_ref: null,
      result_summary: null,
      truncated: 0,
      started_at: null,
      ended_at: null,
      duration_ms: 0,
      created_at: now,
    };
    this.db.run(
      `INSERT INTO tool_calls
         (id, session_id, message_id, call_id, tool_name, tool_wire_name, display_name,
          category, source, risk, approval_mode, channel, iteration, args_json, args_digest,
          status, error_kind, error_msg, result_ref, result_summary, truncated,
          started_at, ended_at, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, 0, NULL, NULL, 0, ?)`,
      [
        row.id, row.session_id, row.message_id, row.call_id, row.tool_name, row.tool_wire_name,
        row.display_name, row.category, row.source, row.risk, row.approval_mode, row.channel,
        row.iteration, row.args_json, row.args_digest, row.created_at,
      ],
    );
    return row;
  }

  get(id: string): ToolCallRow | undefined {
    return this.db.get<ToolCallRow>('SELECT * FROM tool_calls WHERE id = ?', [id]);
  }

  getByCallId(sessionId: string, callId: string): ToolCallRow | undefined {
    return this.db.get<ToolCallRow>(
      'SELECT * FROM tool_calls WHERE session_id = ? AND call_id = ? ORDER BY created_at DESC LIMIT 1',
      [sessionId, callId],
    );
  }

  listBySession(sessionId: string): ToolCallRow[] {
    return this.db.all<ToolCallRow>(
      'SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at ASC',
      [sessionId],
    );
  }

  /** Pending rows of a session — used on recovery to abort orphaned executions. */
  listPendingBySession(sessionId: string): ToolCallRow[] {
    return this.db.all<ToolCallRow>(
      `SELECT * FROM tool_calls WHERE session_id = ? AND status IN ('pending', 'running')
        ORDER BY created_at ASC`,
      [sessionId],
    );
  }

  markRunning(id: string): void {
    const now = Date.now();
    this.db.run(
      `UPDATE tool_calls SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`,
      [now, id],
    );
  }

  markFinished(
    id: string,
    fields: {
      status: ToolCallStatus;
      errorKind?: string | null;
      errorMsg?: string | null;
      resultRef?: string | null;
      resultSummary?: string | null;
      truncated?: boolean;
    },
  ): void {
    const now = Date.now();
    const row = this.get(id);
    const startedAt = row?.started_at ?? now;
    this.db.run(
      `UPDATE tool_calls
          SET status = ?, error_kind = ?, error_msg = ?, result_ref = ?, result_summary = ?,
              truncated = ?, started_at = ?, ended_at = ?, duration_ms = ?
        WHERE id = ?`,
      [
        fields.status, fields.errorKind ?? null, fields.errorMsg ?? null,
        fields.resultRef ?? null, fields.resultSummary ?? null,
        fields.truncated ? 1 : 0, startedAt, now, Math.max(0, now - startedAt), id,
      ],
    );
  }

  /** Marks the row and every later row of the session as skipped (AC-10 resume). */
  markSkippedFrom(id: string): number {
    const row = this.get(id);
    if (!row) return 0;
    return this.db.run(
      `UPDATE tool_calls
          SET status = 'skipped', error_kind = 'revised', error_msg = '用户从该步重跑，本调用被跳过'
        WHERE session_id = ? AND status IN ('pending', 'running')
          AND (created_at > ? OR (created_at = ? AND id != ?))`,
      [row.session_id, row.created_at, row.created_at, id],
    ).changes;
  }

  /** Risk re-verdict may change after a parameter revision (method GET vs POST). */
  setRiskVerdict(id: string, risk: string, approvalMode: string): void {
    this.db.run('UPDATE tool_calls SET risk = ?, approval_mode = ? WHERE id = ?', [
      risk, approvalMode, id,
    ]);
  }

  countFailedSince(sessionId: string, sinceCreatedAt: number): number {
    return this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tool_calls
        WHERE session_id = ? AND created_at >= ? AND status IN ('failed', 'timeout')`,
      [sessionId, sinceCreatedAt],
    )?.n ?? 0;
  }
}
