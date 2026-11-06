/**
 * Health controller (AUDIT-026): the endpoint must report the REAL schema state,
 * the REAL db file size (via the path the app opened, not a re-read of
 * AGENT_DB_PATH), and prove sandbox writability with an actual write rather than
 * a stat.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL, EXPECTED_TABLE_COUNT } from '../src/repositories/schema.js';
import { HealthController } from '../src/controllers/health.controller.js';
import type { Response } from 'express';
import type { McpManagerService } from '../src/services/mcp/mcp-manager.service.js';

const dirs: string[] = [];

function makeController(sandboxRoot: string): { controller: HealthController; db: Db; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'codelens-health-'));
  const dbPath = path.join(dir, 'agent.db');
  const db = createDb(dbPath);
  db.exec(SCHEMA_SQL);
  const mcp = { health: () => ({ servers: 2, healthy: 1 }) } as unknown as McpManagerService;
  const controller = new HealthController(db, mcp, sandboxRoot, dbPath);
  return { controller, db, dir };
}

function captureJson(): { res: Response; body: () => Record<string, any> } {
  let body: Record<string, any> = {};
  const res = { json: (b: Record<string, any>) => { body = b; } } as unknown as Response;
  return { res, body: () => body };
}

describe('AUDIT-026 health controller', () => {
  afterEach(() => {
    // 宿主环境的删除守卫（safe-delete shim）可能在并发下超时。
    // 清理是 best-effort：残留目录由环境侧回收，但不能让它把已通过的用例判红。
    try {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    } catch (err) {
      console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
    }
  });

  it('reports ok with the real table count and a non-zero db size when healthy', () => {
    const sandboxRoot = mkdtempSync(path.join(tmpdir(), 'codelens-sandbox-'));
    dirs.push(sandboxRoot);
    const { controller, db, dir } = makeController(sandboxRoot);
    dirs.push(dir);

    const { res, body } = captureJson();
    controller.check({} as any, res);

    expect(body().status).toBe('ok');
    expect(body().db.ok).toBe(true);
    expect(body().db.tables).toBe(EXPECTED_TABLE_COUNT);
    expect(body().db.expectedTables).toBe(EXPECTED_TABLE_COUNT);
    expect(body().db.sizeBytes).toBeGreaterThan(0);
    expect(body().sandbox.rootConfigured).toBe(true);
    expect(body().sandbox.writable).toBe(true);
    db.close();
  });

  it('reports degraded when the sandbox is not writable (a file, not a dir)', () => {
    const hostDir = mkdtempSync(path.join(tmpdir(), 'codelens-host-'));
    dirs.push(hostDir);
    const fileAsSandbox = path.join(hostDir, 'not-a-dir.txt');
    writeFileSync(fileAsSandbox, 'x');
    const { controller, db, dir } = makeController(fileAsSandbox);
    dirs.push(dir);

    const { res, body } = captureJson();
    controller.check({} as any, res);

    expect(body().sandbox.writable).toBe(false);
    expect(body().status).toBe('degraded');
    db.close();
  });

  it('uses the injected db path even when AGENT_DB_PATH env is absent', () => {
    const sandboxRoot = mkdtempSync(path.join(tmpdir(), 'codelens-sandbox-2-'));
    dirs.push(sandboxRoot);
    const { controller, db, dir } = makeController(sandboxRoot);
    dirs.push(dir);
    // The constructor was given the real dbPath; dbSizeBytes must reflect it
    // (previously it re-read process.env.AGENT_DB_PATH, empty in this test).
    const { res, body } = captureJson();
    controller.check({} as any, res);
    expect(body().db.sizeBytes).toBeGreaterThan(0);
    db.close();
  });
});
