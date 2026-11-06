/**
 * Approval repository: challenge lifecycle with the write-once decision rule.
 *
 * The silent no-op hazard (found by the architect in live testing): SQLite does not
 * error when `UPDATE approvals SET decision=? WHERE id=? AND decision IS NULL` matches
 * zero rows — `changes` is simply 0. The DB trigger only blocks *illegal values*, not
 * writes that never landed. Every decision write therefore asserts `changes === 1`
 * and throws APPROVAL_ALREADY_DECIDED otherwise (AC-06 immutability).
 */

import type { Db } from '../../repositories/db.js';
import { prefixedId } from '../../utils/hash.js';

export type ApprovalStatus = 'pending' | 'decided' | 'expired' | 'aborted' | 'revised';
export type ApprovalDecision = 'allow_once' | 'allow_session' | 'reject' | 'revised';

export interface ApprovalRow {
  id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  args_digest: string;
  challenge_token_hash: string;
  status: ApprovalStatus;
  decision: ApprovalDecision | null;
  reason: string | null;
  mismatch_count: number;
  last_mismatch_at: number | null;
  last_mismatch_detail: string | null;
  revised_from_id: string | null;
  revise_depth: number;
  expires_at: number;
  decided_at: number | null;
  created_at: number;
}

export interface InsertApprovalInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  argsDigest: string;
  challengeTokenHash: string;
  expiresAt: number;
  revisedFromId?: string | null;
  reviseDepth?: number;
}

export class ApprovalRepository {
  constructor(private readonly db: Db) {}

  insert(input: InsertApprovalInput): ApprovalRow {
    const now = Date.now();
    const row: ApprovalRow = {
      id: prefixedId('ap'),
      session_id: input.sessionId,
      tool_call_id: input.toolCallId,
      tool_name: input.toolName,
      args_digest: input.argsDigest,
      challenge_token_hash: input.challengeTokenHash,
      status: 'pending',
      decision: null,
      reason: null,
      mismatch_count: 0,
      last_mismatch_at: null,
      last_mismatch_detail: null,
      revised_from_id: input.revisedFromId ?? null,
      revise_depth: input.reviseDepth ?? 0,
      expires_at: input.expiresAt,
      decided_at: null,
      created_at: now,
    };
    this.db.run(
      `INSERT INTO approvals
         (id, session_id, tool_call_id, tool_name, args_digest, challenge_token_hash,
          status, decision, reason, mismatch_count, last_mismatch_at, last_mismatch_detail,
          revised_from_id, revise_depth, expires_at, decided_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, 0, NULL, NULL, ?, ?, ?, NULL, ?)`,
      [
        row.id, row.session_id, row.tool_call_id, row.tool_name, row.args_digest,
        row.challenge_token_hash, row.revised_from_id, row.revise_depth,
        row.expires_at, row.created_at,
      ],
    );
    return row;
  }

  get(id: string): ApprovalRow | undefined {
    return this.db.get<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', [id]);
  }

  getPendingByToolCall(toolCallId: string): ApprovalRow | undefined {
    return this.db.get<ApprovalRow>(
      // rowid tiebreaker: two challenges issued within the same millisecond would
      // otherwise leave `created_at DESC` order arbitrary.
      `SELECT * FROM approvals WHERE tool_call_id = ? AND status = 'pending'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [toolCallId],
    );
  }

  listBySession(sessionId: string): ApprovalRow[] {
    return this.db.all<ApprovalRow>(
      'SELECT * FROM approvals WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
      [sessionId],
    );
  }

  /**
   * Write-once decision. Throws when the row is missing or already decided —
   * callers map that to APPROVAL_ALREADY_DECIDED (409).
   */
  decide(id: string, decision: Exclude<ApprovalDecision, 'revised'>, reason: string | null): ApprovalRow {
    const now = Date.now();
    const result = this.db.run(
      `UPDATE approvals
          SET decision = ?, reason = ?, decided_at = ?, status = 'decided'
        WHERE id = ? AND decision IS NULL`,
      [decision, reason, now, id],
    );
    if (result.changes !== 1) {
      throw new Error('APPROVAL_ALREADY_DECIDED');
    }
    return this.get(id)!;
  }

  /**
   * Supersedes a challenge after a parameter revision (AC-10).
   * Same write-once guarantee: the WHERE guard can silently match zero rows.
   */
  markRevised(id: string): void {
    const result = this.db.run(
      `UPDATE approvals SET decision = 'revised', status = 'revised'
        WHERE id = ? AND decision IS NULL`,
      [id],
    );
    if (result.changes !== 1) {
      throw new Error('APPROVAL_ALREADY_DECIDED');
    }
  }

  markExpired(id: string): void {
    this.db.run(`UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'pending'`, [id]);
  }

  /**
   * Re-issues a still-pending challenge with a fresh token + extended expiry
   * (AUDIT-009). The write-once guard: must match exactly one pending row.
   */
  reissue(id: string, tokenHash: string, expiresAt: number): void {
    const result = this.db.run(
      `UPDATE approvals SET challenge_token_hash = ?, expires_at = ? WHERE id = ? AND status = 'pending'`,
      [tokenHash, expiresAt, id],
    );
    if (result.changes !== 1) {
      throw new Error('APPROVAL_NOT_PENDING');
    }
  }

  markAborted(id: string): void {
    this.db.run(
      `UPDATE approvals SET status = 'aborted' WHERE id = ? AND status = 'pending'`,
      [id],
    );
  }

  /** Expiry sweep: called before any decision write to keep status honest. */
  expireStale(now: number): number {
    return this.db.run(
      `UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < ?`,
      [now],
    ).changes;
  }

  /** Anomaly audit for token/args mismatch submissions (AC-04 third attack scenario). */
  recordMismatch(id: string, detail: string): number {
    const now = Date.now();
    this.db.run(
      `UPDATE approvals
          SET mismatch_count = mismatch_count + 1, last_mismatch_at = ?, last_mismatch_detail = ?
        WHERE id = ?`,
      [now, detail, id],
    );
    return this.get(id)?.mismatch_count ?? 0;
  }

  /** Aborts every pending challenge of a session (session deleted / task aborted). */
  abortPendingForSession(sessionId: string): number {
    return this.db.run(
      `UPDATE approvals SET status = 'aborted' WHERE session_id = ? AND status = 'pending'`,
      [sessionId],
    ).changes;
  }
}
