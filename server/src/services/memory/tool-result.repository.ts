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
}
