/** Session repository: CRUD, device tokens, recovery codes (hash-only, ADR-022). */

import type { Db } from '../../repositories/db.js';
import { newUuid } from '../../utils/hash.js';

export interface SessionRow {
  id: string;
  title: string;
  provider: string;
  model: string;
  channel_mode: string;
  degraded: number;
  message_count: number;
  total_tokens: number;
  device_token_hash: string | null;
  recovery_code_hash: string | null;
  recovery_code_used_at: number | null;
  recovery_failed_count: number;
  recovery_locked_until: number | null;
  summary: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateSessionInput {
  provider: string;
  model: string;
  title?: string;
  deviceTokenHash?: string | null;
  recoveryCodeHash?: string | null;
}

export class SessionRepository {
  constructor(private readonly db: Db) {}

  create(input: CreateSessionInput): SessionRow {
    const now = Date.now();
    const row: SessionRow = {
      id: newUuid(),
      title: input.title?.slice(0, 200) || '新会话',
      provider: input.provider,
      model: input.model,
      channel_mode: 'auto',
      degraded: 0,
      message_count: 0,
      total_tokens: 0,
      device_token_hash: input.deviceTokenHash ?? null,
      recovery_code_hash: input.recoveryCodeHash ?? null,
      recovery_code_used_at: null,
      recovery_failed_count: 0,
      recovery_locked_until: null,
      summary: null,
      created_at: now,
      updated_at: now,
    };
    this.db.run(
      `INSERT INTO sessions
         (id, title, provider, model, channel_mode, degraded, message_count, total_tokens,
          device_token_hash, recovery_code_hash, recovery_code_used_at, recovery_failed_count,
          recovery_locked_until, summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, NULL, 0, NULL, NULL, ?, ?)`,
      [
        row.id, row.title, row.provider, row.model, row.channel_mode,
        row.device_token_hash, row.recovery_code_hash, row.created_at, row.updated_at,
      ],
    );
    return row;
  }

  get(id: string): SessionRow | undefined {
    return this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [id]);
  }

  /**
   * Lists sessions, optionally filtered by device token hash.
   * null token = 内部无过滤（仅 RecoveryService.recover 用于按恢复码全表扫描）；
   * REST 层的设备过滤在 SessionsController.list 强制（AUDIT-018 fail-closed）。
   */
  list(limit: number, offset: number, deviceTokenHash?: string | null): { items: SessionRow[]; total: number } {
    const where = deviceTokenHash ? 'WHERE device_token_hash = ?' : '';
    const params = deviceTokenHash ? [deviceTokenHash] : [];
    const totalRow = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions ${where}`, params);
    const items = this.db.all<SessionRow>(
      `SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { items, total: totalRow?.n ?? 0 };
  }

  patch(id: string, fields: { title?: string; provider?: string; model?: string }): SessionRow | undefined {
    const sets: string[] = [];
    const params: Array<string | number> = [];
    if (fields.title !== undefined) { sets.push('title = ?'); params.push(fields.title.slice(0, 200)); }
    if (fields.provider !== undefined) { sets.push('provider = ?'); params.push(fields.provider); }
    if (fields.model !== undefined) { sets.push('model = ?'); params.push(fields.model); }
    if (sets.length === 0) return this.get(id);
    sets.push('updated_at = ?');
    params.push(Date.now(), id);
    this.db.run(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.get(id);
  }

  /** Deletes the session row; CASCADE removes messages / tool_calls / results / approvals. */
  remove(id: string): boolean {
    return this.db.run('DELETE FROM sessions WHERE id = ?', [id]).changes === 1;
  }

  bumpCounters(id: string, messageCountDelta: number, tokensDelta: number): void {
    this.db.run(
      `UPDATE sessions
          SET message_count = message_count + ?, total_tokens = total_tokens + ?, updated_at = ?
        WHERE id = ?`,
      [messageCountDelta, tokensDelta, Date.now(), id],
    );
  }

  setDegraded(id: string, degraded: boolean): void {
    this.db.run('UPDATE sessions SET degraded = ?, updated_at = ? WHERE id = ?', [
      degraded ? 1 : 0, Date.now(), id,
    ]);
  }

  setSummary(id: string, summaryJson: string): void {
    this.db.run('UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?', [
      summaryJson, Date.now(), id,
    ]);
  }

  getSummary(id: string): string | null {
    return this.get(id)?.summary ?? null;
  }

  // ── recovery-code lifecycle (AC-05) ────────────────────────────────────────

  setRecoveryCode(id: string, codeHash: string): void {
    this.db.run(
      `UPDATE sessions
          SET recovery_code_hash = ?, recovery_code_used_at = NULL,
              recovery_failed_count = 0, recovery_locked_until = NULL, updated_at = ?
        WHERE id = ?`,
      [codeHash, Date.now(), id],
    );
  }

  /** Marks the code consumed; returns false when it was already used (race-safe). */
  consumeRecoveryCode(id: string): boolean {
    return this.db.run(
      'UPDATE sessions SET recovery_code_used_at = ?, recovery_failed_count = 0 WHERE id = ? AND recovery_code_used_at IS NULL',
      [Date.now(), id],
    ).changes === 1;
  }

  registerRecoveryFailure(id: string, lockedUntil: number | null): void {
    this.db.run(
      `UPDATE sessions
          SET recovery_failed_count = recovery_failed_count + 1,
              recovery_locked_until = COALESCE(?, recovery_locked_until), updated_at = ?
        WHERE id = ?`,
      [lockedUntil, Date.now(), id],
    );
  }

  rebindDevice(id: string, deviceTokenHash: string): void {
    this.db.run('UPDATE sessions SET device_token_hash = ?, updated_at = ? WHERE id = ?', [
      deviceTokenHash, Date.now(), id,
    ]);
  }
}
