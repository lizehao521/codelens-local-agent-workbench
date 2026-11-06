/**
 * 工作区快照仓储：workspace_checkpoints 表的读写。
 *
 * 表只存「快照元信息 + 清单」：文件正文不落 DB（正文在 blobRoot/<id>/ 下），
 * 所以 manifest_json 里只有 relPath / sha256 / size / blobPath 四项。
 *
 * 审计数据不级联删除：会话没了，当时的快照仍应可复盘、可回滚。
 */

import type { Db } from './db.js';

export interface CheckpointRow {
  id: string;
  session_id: string;
  label: string;
  root: string;
  file_count: number;
  total_bytes: number;
  manifest_json: string;
  created_at: number;
  run_id: string | null;
  step: number | null;
  tool_call_ids_json: string;
  after_manifest_json: string | null;
  diff_json: string | null;
  status: 'active' | 'pruned';
  restored_at: number | null;
  restore_json: string | null;
  pinned: number;
}

export interface InsertCheckpointInput {
  id: string;
  sessionId: string;
  label: string;
  /** 捕获时的工作区根（绝对路径）。 */
  root: string;
  fileCount: number;
  totalBytes: number;
  /** 已编码的 manifest（JSON 字符串）。编码在 service 侧完成。 */
  manifestJson: string;
  createdAt: number;
  /** run 级证据链：哪一次 run、第几步、由哪些工具调用触发。 */
  runId?: string | null;
  step?: number | null;
  toolCallIds?: string[];
}

/** 列表默认返回条数上限：避免一次性把整个快照历史拉进内存。 */
const DEFAULT_LIST_LIMIT = 200;

export class CheckpointRepository {
  constructor(private readonly db: Db) {}

  insert(input: InsertCheckpointInput): void {
    this.db.run(
      `INSERT INTO workspace_checkpoints
         (id, session_id, label, root, file_count, total_bytes, manifest_json, created_at,
          run_id, step, tool_call_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.sessionId,
        input.label,
        input.root,
        input.fileCount,
        input.totalBytes,
        input.manifestJson,
        input.createdAt,
        input.runId ?? null,
        input.step ?? null,
        JSON.stringify(input.toolCallIds ?? []),
      ],
    );
  }

  /** 按 run 查证据链，按 step 升序（同一步内按创建时间）。 */
  listByRun(runId: string): CheckpointRow[] {
    return this.db.all<CheckpointRow>(
      `SELECT * FROM workspace_checkpoints WHERE run_id = ? ORDER BY step ASC, created_at ASC, id ASC`,
      [runId],
    );
  }

  /** 写入 after 清单与 diff（同一条 before 记录上回填）。 */
  updateAfter(id: string, afterManifestJson: string, diffJson: string): number {
    return this.db.run(
      `UPDATE workspace_checkpoints SET after_manifest_json = ?, diff_json = ? WHERE id = ?`,
      [afterManifestJson, diffJson, id],
    ).changes;
  }

  /** 撤销留痕：谁被还原、还原了什么、何时。 */
  markRestored(id: string, restoreJson: string, at: number): number {
    return this.db.run(
      `UPDATE workspace_checkpoints SET restored_at = ?, restore_json = ? WHERE id = ?`,
      [at, restoreJson, id],
    ).changes;
  }

  /** 保留策略：先到先淘汰（最老的先走），pinned 永久保留。 */
  listOldRuns(limitRuns: number): Array<{ run_id: string; max_created: number }> {
    return this.db.all<{ run_id: string; max_created: number }>(
      `SELECT run_id, MAX(created_at) AS max_created
         FROM workspace_checkpoints
        WHERE run_id IS NOT NULL AND pinned = 0 AND status = 'active'
        GROUP BY run_id
        ORDER BY max_created DESC`,
    ).slice(Math.max(limitRuns, 0));
  }

  /** 淘汰正文：保留行与 diff 摘要，只把 status 标为 pruned。 */
  markPruned(ids: string[]): number {
    let changes = 0;
    for (const id of ids) {
      changes += this.db.run(
        `UPDATE workspace_checkpoints SET status = 'pruned' WHERE id = ? AND pinned = 0`,
        [id],
      ).changes;
    }
    return changes;
  }

  /** 保留策略按字节淘汰：最老的 active run 在前。 */
  listActiveRunsOldest(): Array<{ run_id: string; bytes: number }> {
    return this.db.all<{ run_id: string; bytes: number }>(
      `SELECT run_id, SUM(total_bytes) AS bytes
         FROM workspace_checkpoints
        WHERE run_id IS NOT NULL AND pinned = 0 AND status = 'active'
        GROUP BY run_id
        ORDER BY MAX(created_at) ASC`,
    );
  }

  totalActiveBytes(): number {
    const row = this.db.get<{ bytes: number }>(
      `SELECT COALESCE(SUM(total_bytes), 0) AS bytes FROM workspace_checkpoints WHERE status = 'active' AND pinned = 0`,
    );
    return row?.bytes ?? 0;
  }

  pin(id: string, pinned: boolean): number {
    return this.db.run(`UPDATE workspace_checkpoints SET pinned = ? WHERE id = ?`, [pinned ? 1 : 0, id]).changes;
  }

  listPruned(limit = 500): CheckpointRow[] {
    return this.db.all<CheckpointRow>(
      `SELECT * FROM workspace_checkpoints WHERE status = 'pruned' ORDER BY created_at ASC LIMIT ?`,
      [limit],
    );
  }

  get(id: string): CheckpointRow | undefined {
    return this.db.get<CheckpointRow>(`SELECT * FROM workspace_checkpoints WHERE id = ?`, [id]);
  }

  /**
   * 按会话过滤；不传则返回全部会话的快照。
   * 排序：created_at DESC（同毫秒内用 id 兜底，保证顺序稳定）。
   */
  list(sessionId?: string, limit = DEFAULT_LIST_LIMIT): CheckpointRow[] {
    const capped = Math.min(Math.max(Math.trunc(limit), 1), DEFAULT_LIST_LIMIT);
    if (sessionId) {
      return this.db.all<CheckpointRow>(
        `SELECT * FROM workspace_checkpoints
          WHERE session_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        [sessionId, capped],
      );
    }
    return this.db.all<CheckpointRow>(
      `SELECT * FROM workspace_checkpoints
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      [capped],
    );
  }

  /** 显式删除一条快照记录（正文目录不在 DB 里，由调用方一并清理）。 */
  delete(id: string): number {
    const result = this.db.run(`DELETE FROM workspace_checkpoints WHERE id = ?`, [id]);
    return result.changes;
  }
}
