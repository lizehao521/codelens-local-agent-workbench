/**
 * sandbox_permission_config 单行持久化（id=1）。
 * 仅存储经服务端硬校验后的 config（realpath 绝对目录 + autoApprove 开关）。
 *
 * 注意：本项目 ORM 封装是 node:sqlite 的 Db 接口（见 ./db.ts），只暴露
 * get/run/all/exec/transaction，没有 prepare —— 一律走 db.get / db.run。
 */

import type { Db } from './db.js';
import { DEFAULT_PERMISSION_CONFIG, type SandboxPermissionConfig } from '../services/tools/sandbox-permission.js';

export class SandboxPermissionRepository {
  constructor(private readonly db: Db) {}

  get(): SandboxPermissionConfig {
    const row = this.db.get<{ config_json: string }>(
      'SELECT config_json FROM sandbox_permission_config WHERE id = 1',
    );
    if (!row) return structuredClone(DEFAULT_PERMISSION_CONFIG);
    try {
      return JSON.parse(row.config_json) as SandboxPermissionConfig;
    } catch {
      return structuredClone(DEFAULT_PERMISSION_CONFIG);
    }
  }

  set(config: SandboxPermissionConfig): void {
    this.db.run(
      `INSERT INTO sandbox_permission_config (id, config_json, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
      [JSON.stringify(config), Date.now()],
    );
  }
}
