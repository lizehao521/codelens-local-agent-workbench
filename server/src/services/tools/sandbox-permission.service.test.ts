/**
 * SandboxPermissionService：内存缓存 + 持久化 + 服务端硬校验（用 fake db，不依赖 better-sqlite3 原生模块）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse as parsePath } from 'node:path';
import type { Db } from '../../repositories/db.js';
import { SandboxPermissionService } from './sandbox-permission.service.js';

/** 极简 fake db：仅实现 SandboxPermissionRepository 用到的 Db.get / Db.run。
 *  Db.run 签名是 run(sql, params?)，持久化的 JSON 在 params[0]。 */
function makeFakeDb(initial?: { config_json: string }): Db {
  let row = initial;
  return {
    get: () => row,
    run: (_sql: string, params?: unknown[]) => {
      row = { config_json: String(params?.[0]) };
      return { changes: 1 };
    },
  } as unknown as Db;
}

// 临时根必须落在受限目录前缀之外（见 sandbox-permission.test.ts 注释）。
const TMP_BASE = join(parsePath(tmpdir()).root, 'codelens-sp-');

describe('SandboxPermissionService', () => {
  let base: string;
  let sandboxRoot: string;
  let goodDir: string;

  beforeAll(() => {
    base = mkdtempSync(TMP_BASE + 'svc-');
    sandboxRoot = join(base, 'sandbox');
    goodDir = join(base, 'work');
    mkdirSync(sandboxRoot, { recursive: true });
    mkdirSync(goodDir, { recursive: true });
  });

  afterAll(() => {
    // 宿主环境的删除守卫（safe-delete shim）可能在并发下超时。
    // 清理是 best-effort：残留目录由环境侧回收，但不能让它把已通过的用例判红。
    try {
      rmSync(base, { recursive: true, force: true });
    } catch (err) {
      console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
    }
  });


  it('构造时缺省返回 DEFAULT 配置', () => {
    const svc = new SandboxPermissionService(makeFakeDb(), sandboxRoot);
    expect(svc.getConfig()).toEqual({ allowDirs: [], autoApprove: { fsDestructive: false, purge: false, httpWrite: false } });
  });

  it('update 接受合法 allowDir 并持久化', () => {
    const db = makeFakeDb();
    const svc = new SandboxPermissionService(db, sandboxRoot);
    const res = svc.update({ allowDirs: [goodDir] });
    expect(res.ok).toBe(true);
    expect(svc.allowDirs.length).toBe(1);
    // 持久化：再构造一次应读到已写入的目录
    const svc2 = new SandboxPermissionService(db, sandboxRoot);
    expect(svc2.allowDirs.length).toBe(1);
  });

  it('update 拒绝非法 allowDir 时整体拒绝，不写入', () => {
    const db = makeFakeDb();
    const svc = new SandboxPermissionService(db, sandboxRoot);
    const res = svc.update({ allowDirs: ['/no/such/dir-xyz'] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.rejected.length).toBe(1);
      expect(res.rejected[0]!.dir).toBe('/no/such/dir-xyz');
    }
    // 未被写入
    const svc2 = new SandboxPermissionService(db, sandboxRoot);
    expect(svc2.allowDirs.length).toBe(0);
  });

  it('update 仅覆盖 autoApprove，保留已有 allowDirs', () => {
    const db = makeFakeDb();
    const svc = new SandboxPermissionService(db, sandboxRoot);
    svc.update({ allowDirs: [goodDir] });
    const res = svc.update({ autoApprove: { fsDestructive: true } });
    expect(res.ok).toBe(true);
    expect(svc.allowDirs.length).toBe(1);
    expect(svc.autoApprove.fsDestructive).toBe(true);
  });
});
