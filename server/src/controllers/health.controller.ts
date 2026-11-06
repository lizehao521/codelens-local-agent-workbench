/** Health controller: process + db + mcp + sandbox status (spec 3.3.1). */

import type { Request, Response } from 'express';
import { existsSync, statSync } from 'node:fs';
import type { Db } from '../repositories/db.js';
import { EXPECTED_TABLE_COUNT } from '../repositories/schema.js';
import { APP_VERSION } from '../config/version.js';
import { probeSandboxWritable } from '../utils/sandbox-probe.js';
import type { McpManagerService } from '../services/mcp/mcp-manager.service.js';

export class HealthController {
  constructor(
    private readonly db: Db,
    private readonly mcp: McpManagerService,
    private readonly sandboxRoot: string,
    /**
     * Resolved SQLite file path (config.agentDbPath). The size probe used to
     * re-read `process.env.AGENT_DB_PATH`, which is empty on desktop/custom
     * deployments — so it always reported 0 (AUDIT-026). We now take the path
     * the app actually opened.
     */
    private readonly dbPath: string,
  ) {}

  check(_req: Request, res: Response): void {
    let dbOk = false;
    let sizeBytes = 0;
    let tableCount = 0;
    let degraded = false;
    try {
      const tables = this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      );
      tableCount = tables?.n ?? 0;
      // AUDIT-026: assert the real schema is present, not a stale magic number.
      dbOk = tableCount >= EXPECTED_TABLE_COUNT;
      sizeBytes = this.dbSizeBytes();
    } catch {
      dbOk = false;
      degraded = true;
    }
    // A read-only sandbox mount passes existsSync + isDirectory but silently
    // drops every tool result. "Writable" must be proven by an actual write.
    const sandboxWritable = probeSandboxWritable(this.sandboxRoot);
    const sandboxConfigured = this.sandboxRoot.length > 0;
    const mcpHealth = this.mcp.health();
    // A configured-but-unwritable sandbox is a real degradation; an unconfigured
    // one is a deployment choice and is not penalised here.
    const status = degraded || !dbOk || (sandboxConfigured && !sandboxWritable) ? 'degraded' : 'ok';
    res.json({
      status,
      uptime: Math.round(process.uptime() * 1000) / 1000,
      // 版本号读 package.json（唯一真相源），不再写字面量：
      // 写死会与安装包版本、仓库版本长期漂移。
      version: APP_VERSION,
      db: { ok: dbOk, sizeBytes, degraded, tables: tableCount, expectedTables: EXPECTED_TABLE_COUNT },
      mcp: mcpHealth,
      sandbox: { rootConfigured: sandboxConfigured, writable: sandboxWritable },
    });
  }

  private dbSizeBytes(): number {
    try {
      if (!this.dbPath || !existsSync(this.dbPath)) return 0;
      return statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }
}
