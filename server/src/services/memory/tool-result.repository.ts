/** Tool-result repository: externalized results, preview + artifact pointer (no artifacts table). */

import type { Db } from '../../repositories/db.js';
import { newUuid } from '../../utils/hash.js';

export interface ToolResultRow {
  id: string;
  tool_call_id: string;
  inline_preview: string | null;
  artifact_path: string | null;
  bytes: number;
  truncated: number;
  sha256: string | null;
  created_at: number;
}

export class ToolResultRepository {
  constructor(private readonly db: Db) {}

  insert(fields: {
    toolCallId: string;
    inlinePreview: string | null;
    artifactPath: string | null;
    bytes: number;
    truncated: boolean;
    sha256: string | null;
  }): ToolResultRow {
    const row: ToolResultRow = {
      id: newUuid(),
      tool_call_id: fields.toolCallId,
      inline_preview: fields.inlinePreview,
      artifact_path: fields.artifactPath,
      bytes: fields.bytes,
      truncated: fields.truncated ? 1 : 0,
      sha256: fields.sha256,
      created_at: Date.now(),
    };
    this.db.run(
      `INSERT INTO tool_results (id, tool_call_id, inline_preview, artifact_path, bytes, truncated, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.tool_call_id, row.inline_preview, row.artifact_path, row.bytes, row.truncated, row.sha256, row.created_at],
    );
    return row;
  }

  getByCallId(toolCallId: string): ToolResultRow | undefined {
    return this.db.get<ToolResultRow>(
      'SELECT * FROM tool_results WHERE tool_call_id = ? ORDER BY created_at DESC LIMIT 1',
      [toolCallId],
    );
  }

  /** Reads back the full artifact for `fs.read` zero-new-tool recall (architecture 2.1 rule 2). */
  getById(id: string): ToolResultRow | undefined {
    return this.db.get<ToolResultRow>('SELECT * FROM tool_results WHERE id = ?', [id]);
  }

  /**
   * P1-6 artifacts 面板：列出某会话下所有已落盘的 artifact（join tool_calls 拿会话归属
   * 与工具名）。只读查询，供 ArtifactService 做列表视图；顺序按创建时间升序（面板按
   * 时间线展示）。
   */
  listBySession(sessionId: string): Array<ToolResultRow & { tool_name: string; call_id: string }> {
    return this.db.all<ToolResultRow & { tool_name: string; call_id: string }>(
      `SELECT tr.*, tc.tool_name AS tool_name, tc.call_id AS call_id
         FROM tool_results tr
         JOIN tool_calls tc ON tc.id = tr.tool_call_id
        WHERE tc.session_id = ?
        ORDER BY tr.created_at ASC`,
      [sessionId],
    );
  }

  /** P1-6: 按 result id 取行并校验其归属会话，防止跨会话读 artifact。 */
  getByIdInSession(id: string, sessionId: string): (ToolResultRow & { tool_name: string; call_id: string }) | undefined {
    return this.db.get<ToolResultRow & { tool_name: string; call_id: string }>(
      `SELECT tr.*, tc.tool_name AS tool_name, tc.call_id AS call_id
         FROM tool_results tr
         JOIN tool_calls tc ON tc.id = tr.tool_call_id
        WHERE tr.id = ? AND tc.session_id = ?`,
      [id, sessionId],
    );
  }
}
