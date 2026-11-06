/** Message repository: append-only log with segment structure (C-6). */

import type { Db } from '../../repositories/db.js';
import { newUuid } from '../../utils/hash.js';

export interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  segments_json: string | null;
  reasoning_content: string | null;
  tool_calls_json: string | null;
  tool_call_id: string | null;
  finish_reason: string | null;
  usage_json: string | null;
  tokens: number;
  is_summary: number;
  created_at: number;
}

export interface InsertMessageInput {
  sessionId: string;
  role: MessageRow['role'];
  content: string;
  segmentsJson?: string | null;
  reasoningContent?: string | null;
  toolCallsJson?: string | null;
  toolCallId?: string | null;
  finishReason?: string | null;
  usageJson?: string | null;
  tokens?: number;
  isSummary?: boolean;
}

export class MessageRepository {
  constructor(private readonly db: Db) {}

  /** Assigns the next in-session seq (unique index guards concurrent appends). */
  insert(input: InsertMessageInput): MessageRow {
    const seqRow = this.db.get<{ next: number }>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE session_id = ?',
      [input.sessionId],
    );
    return this.insertWithSeq(input, seqRow?.next ?? 1);
  }

  /**
   * Inserts a row at an explicit seq, shifting every later row up by one.
   *
   * ContextManager needs this: a compaction anchor belongs at the head/tail
   * boundary it summarises, NOT at the end of the log. Appending it (what plain
   * `insert` does) makes it the newest row, so `lastAnchorIndex` resolves the
   * live region to everything AFTER the anchor — which is empty on the next
   * turn — and the L3 tail that AC-09 promises to keep is silently dropped
   * from every subsequent view. Shifting rows keeps history order truthful:
   * everything before the anchor is covered by the summary, everything after
   * it is still live.
   */
  insertAt(input: InsertMessageInput, seq: number): MessageRow {
    const later = this.db.all<{ id: string; seq: number }>(
      'SELECT id, seq FROM messages WHERE session_id = ? AND seq >= ? ORDER BY seq DESC',
      [input.sessionId, seq],
    );
    return this.db.transaction(() => {
      // Descending: the largest row moves into an empty slot first, so each
      // write frees the slot the next write targets (uq_messages_session_seq).
      for (const row of later) {
        this.db.run('UPDATE messages SET seq = ? WHERE id = ?', [row.seq + 1, row.id]);
      }
      return this.insertWithSeq(input, seq);
    });
  }

  private insertWithSeq(input: InsertMessageInput, seq: number): MessageRow {
    const now = Date.now();
    const row: MessageRow = {
      id: newUuid(),
      session_id: input.sessionId,
      seq,
      role: input.role,
      content: input.content,
      segments_json: input.segmentsJson ?? null,
      reasoning_content: input.reasoningContent ?? null,
      tool_calls_json: input.toolCallsJson ?? null,
      tool_call_id: input.toolCallId ?? null,
      finish_reason: input.finishReason ?? null,
      usage_json: input.usageJson ?? null,
      tokens: input.tokens ?? 0,
      is_summary: input.isSummary ? 1 : 0,
      created_at: now,
    };
    this.db.run(
      `INSERT INTO messages
         (id, session_id, seq, role, content, segments_json, reasoning_content,
          tool_calls_json, tool_call_id, finish_reason, usage_json, tokens, is_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.session_id, row.seq, row.role, row.content, row.segments_json,
        row.reasoning_content, row.tool_calls_json, row.tool_call_id, row.finish_reason,
        row.usage_json, row.tokens, row.is_summary, row.created_at,
      ],
    );
    return row;
  }

  listBySession(sessionId: string): MessageRow[] {
    return this.db.all<MessageRow>(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC',
      [sessionId],
    );
  }

  get(id: string): MessageRow | undefined {
    return this.db.get<MessageRow>('SELECT * FROM messages WHERE id = ?', [id]);
  }

  /** Finalizes an assistant message once the turn ends (segments, usage, finish reason). */
  finalize(
    id: string,
    fields: {
      content?: string;
      segmentsJson?: string | null;
      reasoningContent?: string | null;
      finishReason?: string | null;
      usageJson?: string | null;
      tokens?: number;
    },
  ): void {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    if (fields.content !== undefined) { sets.push('content = ?'); params.push(fields.content); }
    if (fields.segmentsJson !== undefined) { sets.push('segments_json = ?'); params.push(fields.segmentsJson); }
    if (fields.reasoningContent !== undefined) { sets.push('reasoning_content = ?'); params.push(fields.reasoningContent); }
    if (fields.finishReason !== undefined) { sets.push('finish_reason = ?'); params.push(fields.finishReason); }
    if (fields.usageJson !== undefined) { sets.push('usage_json = ?'); params.push(fields.usageJson); }
    if (fields.tokens !== undefined) { sets.push('tokens = ?'); params.push(fields.tokens); }
    if (sets.length === 0) return;
    params.push(id);
    this.db.run(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  countBySession(sessionId: string): number {
    return this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', [sessionId],
    )?.n ?? 0;
  }

  /**
   * Rewinds the message log for AC-10 resume. Messages are append-only for audit,
   * but a resume re-runs history with different context — the stale tail is
   * replaced by fresh rows, and the superseded tool_calls are kept as `skipped`.
   */
  deleteAfter(sessionId: string, messageId: string | null): number {
    if (!messageId) return 0;
    const rows = this.listBySession(sessionId);
    const index = rows.findIndex((row) => row.id === messageId);
    if (index < 0) return 0;
    const stale = rows.slice(index + 1);
    if (stale.length === 0) return 0;
    this.db.transaction(() => {
      for (const row of stale) {
        this.db.run('DELETE FROM messages WHERE id = ?', [row.id]);
      }
    });
    return stale.length;
  }

  deleteById(messageId: string): boolean {
    return this.db.run('DELETE FROM messages WHERE id = ?', [messageId]).changes === 1;
  }

  /**
   * AUDIT-028 对账：按 messages.usage_json 聚合精确 prompt/completion 用量
   * （区别于 sessions.total_tokens 的 estimateTextTokens 估值）。损坏 JSON 按 0 计。
   */
  usageBySession(sessionId: string): {
    promptTokens: number;
    completionTokens: number;
    byMessage: Array<{
      id: string;
      seq: number;
      role: MessageRow['role'];
      promptTokens: number;
      completionTokens: number;
    }>;
  } {
    const rows = this.listBySession(sessionId);
    let promptTokens = 0;
    let completionTokens = 0;
    const byMessage: Array<{
      id: string;
      seq: number;
      role: MessageRow['role'];
      promptTokens: number;
      completionTokens: number;
    }> = [];
    for (const row of rows) {
      let prompt = 0;
      let completion = 0;
      if (row.usage_json) {
        try {
          const parsed = JSON.parse(row.usage_json) as { promptTokens?: unknown; completionTokens?: unknown };
          prompt = typeof parsed.promptTokens === 'number' ? parsed.promptTokens : 0;
          completion = typeof parsed.completionTokens === 'number' ? parsed.completionTokens : 0;
        } catch {
          // 损坏的 usage_json 按 0 计
        }
      }
      promptTokens += prompt;
      completionTokens += completion;
      byMessage.push({ id: row.id, seq: row.seq, role: row.role, promptTokens: prompt, completionTokens: completion });
    }
    return { promptTokens, completionTokens, byMessage };
  }
}
