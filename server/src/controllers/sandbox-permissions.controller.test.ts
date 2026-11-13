/**
 * SandboxPermissionsController：GET / PUT 行为（fake db，不依赖 better-sqlite3）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../repositories/db.js';
import { SandboxPermissionsController } from './sandbox-permissions.controller.js';
import { SandboxPermissionService } from '../services/tools/sandbox-permission.service.js';

// 临时根必须落在受限目录前缀之外（见 sandbox-permission.test.ts 注释）。
const TMP_BASE = join(tmpdir(), 'codelens-sp-');

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

function mockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.body = undefined;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj: unknown) => {
    res.body = obj;
    return res;
  };
  return res;
}

describe('SandboxPermissionsController', () => {
  let base: string;
  let sandboxRoot: string;
  let goodDir: string;
  let svc: SandboxPermissionService;
  let controller: SandboxPermissionsController;

  beforeAll(() => {
    base = mkdtempSync(TMP_BASE + 'ctrl-');
    sandboxRoot = join(base, 'sandbox');
    goodDir = join(base, 'work');
    mkdirSync(sandboxRoot, { recursive: true });
    mkdirSync(goodDir, { recursive: true });
    svc = new SandboxPermissionService(makeFakeDb(), sandboxRoot);
    controller = new SandboxPermissionsController(svc);
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


  it('GET 返回当前配置（缺省为空白名单 + 全 false 豁免）', () => {
    const res = mockRes();
    controller.get({} as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.allowDirs).toEqual([]);
    expect(res.body.autoApprove).toEqual({ fsDestructive: false, purge: false, httpWrite: false });
  });

  it('PUT 仅更新 autoApprove 成功（200 + 回显）', () => {
    const res = mockRes();
    controller.put({ body: { autoApprove: { fsDestructive: true } } } as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.autoApprove.fsDestructive).toBe(true);
  });

  it('PUT 含非法 allowDir 整体拒绝（422 + rejected 列表）', () => {
    const res = mockRes();
    controller.put({ body: { allowDirs: ['/no/such/dir-xyz'] } } as any, res);
    expect(res.statusCode).toBe(422);
    expect(res.body.error).toBe('INVALID_ALLOW_DIRS');
    expect(Array.isArray(res.body.rejected)).toBe(true);
    expect(res.body.rejected[0].dir).toBe('/no/such/dir-xyz');
  });

  it('PUT 接受合法 allowDir（200）', () => {
    const res = mockRes();
    controller.put({ body: { allowDirs: [goodDir] } } as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.allowDirs.length).toBe(1);
  });
});
