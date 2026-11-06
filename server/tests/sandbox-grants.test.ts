/**
 * 工作区外「按目录授权」自证：
 *  - 首次访问必须弹一次（授权前不执行）；
 *  - 允许后持久化，后续同目录/子目录直接放行，不再弹；
 *  - 拒绝 → deny，不落授权；
 *  - 超时 / 中止 → deny（fail-closed）；
 *  - 敏感目录（.ssh/.aws/密钥）永不弹授权，直接 deny。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { SandboxGrantService } from '../src/services/tools/sandbox-grant.service.js';

let db: Db;
let base: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  base = await mkdtemp(path.join(tmpdir(), 'codelens-grant-'));
  workspace = path.join(base, 'ws');
  outside = path.join(base, 'outside');
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  db.close();
  await rm(base, { recursive: true, force: true });
});

describe('SandboxGrantService', () => {
  it('首次越界 → 弹授权；允许后持久化，第二次不再弹', async () => {
    const svc = new SandboxGrantService(db, workspace, { timeoutMs: 1000 });
    const emitted: string[] = [];
    const pending = svc.requireGrant('se_1', outside, (req) => emitted.push(req.grantId));

    // 尚未决定：处于挂起态。
    expect(emitted).toHaveLength(1);
    expect(svc.list()).toHaveLength(0);
    const decided = svc.decide(emitted[0], true);
    expect(decided).toEqual({ ok: true, decision: 'allow' });
    expect(await pending).toBe('allow');

    // 持久化 + 覆盖子路径。
    expect(svc.list()).toHaveLength(1);
    expect(svc.activeDirs()).toEqual([path.resolve(outside)]);
    expect(svc.covers(path.join(outside, 'a.txt'))).toBe(true);

    // 第二次同目录：直接 allow，不弹。
    const again = await svc.requireGrant('se_1', outside, (req) => emitted.push(req.grantId));
    expect(again).toBe('allow');
    expect(emitted).toHaveLength(1);
  });

  it('拒绝 → deny，且不落授权', async () => {
    const svc = new SandboxGrantService(db, workspace, { timeoutMs: 1000 });
    const emitted: string[] = [];
    const pending = svc.requireGrant('se_1', outside, (req) => emitted.push(req.grantId));
    const decided = svc.decide(emitted[0], false);
    expect(decided).toEqual({ ok: true, decision: 'deny' });
    expect(await pending).toBe('deny');
    expect(svc.list()).toHaveLength(0);
  });

  it('超时 → expired（fail-closed），不落授权', async () => {
    const svc = new SandboxGrantService(db, workspace, { timeoutMs: 50 });
    const emitted: string[] = [];
    const pending = svc.requireGrant('se_1', outside, (req) => emitted.push(req.grantId));
    expect(await pending).toBe('expired');
    expect(emitted).toHaveLength(1);
    expect(svc.list()).toHaveLength(0);
  });

  it('会话中止 → 所有待决请求 deny（executor 不会永久挂起）', async () => {
    const svc = new SandboxGrantService(db, workspace, { timeoutMs: 5000 });
    const emitted: string[] = [];
    const pending = svc.requireGrant('se_1', outside, (req) => emitted.push(req.grantId));
    svc.abortSession('se_1');
    expect(await pending).toBe('deny');
  });

  it('敏感目录 .ssh → 直接 deny，不弹授权，不落库', async () => {
    const ssh = path.join(outside, '.ssh');
    await mkdir(ssh, { recursive: true });
    const svc = new SandboxGrantService(db, workspace, { timeoutMs: 1000 });
    const emitted: string[] = [];
    const decision = await svc.requireGrant('se_1', ssh, (req) => emitted.push(req.grantId));
    expect(decision).toBe('deny');
    expect(emitted).toHaveLength(0);
    expect(svc.list()).toHaveLength(0);
  });

  it('撤销后再次访问会重新弹授权', async () => {
    const svc = new SandboxGrantService(db, workspace, { timeoutMs: 1000 });
    const emitted: string[] = [];
    const pending = svc.requireGrant('se_1', outside, (req) => emitted.push(req.grantId));
    svc.decide(emitted[0], true);
    expect(await pending).toBe('allow');
    expect(svc.revoke(emitted[0])).toBe(true);
    // 撤销是软删除：历史仍可查（列表只返回 active，但行未删）。
    expect(svc.list()).toHaveLength(0);
    expect(svc.covers(path.join(outside, 'a.txt'))).toBe(false);
  });
});
