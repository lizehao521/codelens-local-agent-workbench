/**
 * sandbox_grants 仓储：按目录授权的持久化单一事实源。
 *
 * 只存 realpath（判定后不可变的目标）；原始输入目录另存一份，便于 UI 展示
 * 「你授权的是哪个目录」。撤销只写 revoked_at，不删行 —— 授权历史同样要可审计。
 */

import type { Db } from './db.js';

export interface SandboxGrantRow {
  id: string;
  dir: string;
  real_path: string;
  sensitive: number;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export class SandboxGrantRepository {
  constructor(private readonly db: Db) {}

  insert(input: { id: string; dir: string; realPath: string; sensitive: boolean }): void {
    this.db.run(
      `INSERT INTO sandbox_grants (id, dir, real_path, sensitive, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      [input.id, input.dir, input.realPath, input.sensitive ? 1 : 0, Date.now()],
    );
  }

  listActive(sessionId?: string): SandboxGrantRow[] {
    void sessionId; // 当前 schema 未按会话隔离授权：目录授权是设备级的知情选择。
    return this.db.all<SandboxGrantRow>(
      `SELECT id, dir, real_path, sensitive, created_at, last_used_at, revoked_at
         FROM sandbox_grants WHERE revoked_at IS NULL ORDER BY created_at DESC`,
    );
  }

  findActiveByRealPath(realPath: string): SandboxGrantRow | undefined {
    return this.db.get<SandboxGrantRow>(
      `SELECT id, dir, real_path, sensitive, created_at, last_used_at, revoked_at
         FROM sandbox_grants WHERE real_path = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [realPath],
    );
  }

  touch(id: string): void {
    this.db.run('UPDATE sandbox_grants SET last_used_at = ? WHERE id = ?', [Date.now(), id]);
  }

  revoke(id: string): number {
    const res = this.db.run('UPDATE sandbox_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
      Date.now(),
      id,
    ]);
    return res.changes > 0 ? 1 : 0;
  }
}
