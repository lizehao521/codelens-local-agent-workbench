/**
 * CheckpointService / CheckpointsController 单测（P0-2 工作区快照与回滚）。
 *
 * 覆盖三条主线：
 *  - 正常：捕获 → list 可见 → restore 还原「被修改」与「被删除」的文件，sha256 一致；
 *  - 边界：空工作区、超 maxFiles / maxBytes、单文件超大、sessionId 过滤、restore 不存在的 id；
 *  - 异常：路径穿越被拒、符号链接指向工作区外被拒、未启用时的 capture/list 行为、
 *          缺确认头 → 400、未启用 → 409。
 *
 * 文件 IO 一律走 node:fs/promises + os.tmpdir() 造临时工作区，
 * 绝不碰真实 workspace（沙箱根默认在 <server>/workspace）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import {
  CheckpointDisabledError,
  CheckpointNotFoundError,
  CheckpointPathError,
  CheckpointService,
} from '../src/services/tx/checkpoint.service.js';
import { CheckpointsController } from '../src/controllers/checkpoints.controller.js';

const SESSION = 'se_ckpt';

/** 临时根落在受限目录前缀之外（见 sandbox-permission.service.test.ts 注释）。 */
const TMP_PREFIX = path.join(tmpdir(), 'codelens-ckpt-');

let db: Db;
let base: string;
let workspace: string;
let blobRoot: string;
let outsideDir: string;

function makeService(
  overrides: Partial<{
    enabled: boolean;
    maxFiles: number;
    maxBytes: number;
    sandboxRoot: string;
    blobRoot: string;
  }> = {},
): CheckpointService {
  return new CheckpointService({
    db,
    sandboxRoot: overrides.sandboxRoot ?? workspace,
    enabled: overrides.enabled ?? true,
    maxFiles: overrides.maxFiles ?? 0,
    maxBytes: overrides.maxBytes ?? 0,
    blobRoot: overrides.blobRoot ?? blobRoot,
  });
}

async function writeFileIn(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 读回 DB 里的清单（校验 sha256 用）。 */
function readManifest(checkpointId: string): Array<{
  relPath: string;
  sha256: string;
  size: number;
  blobPath: string;
}> {
  const row = db.get<{ manifest_json: string }>(
    `SELECT manifest_json FROM workspace_checkpoints WHERE id = ?`,
    [checkpointId],
  );
  if (!row) throw new Error(`快照不存在: ${checkpointId}`);
  return JSON.parse(row.manifest_json);
}

// ── controller 的 mock req/res（形状对齐 sandbox-permissions.controller.test.ts）────
function mockRes() {
  const res: { statusCode: number; body?: unknown; status: (c: number) => unknown; json: (b: unknown) => unknown } = {
    statusCode: 200,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

beforeEach(async () => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  base = await mkdtemp(TMP_PREFIX);
  workspace = path.join(base, 'workspace');
  blobRoot = path.join(base, 'blobs');
  outsideDir = path.join(base, 'outside');
  await mkdir(workspace, { recursive: true });
  await mkdir(blobRoot, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
});

afterEach(async () => {
  db.close();
  // 清理必须**不参与用例计时**：宿主的删除守卫（safe-delete shim）单次删除
  // 可能要等数十秒的 genie-trash 子进程，若在这里 await rm，这段等待会被
  // 算进 afterEach 的 hook 超时，表现为「用例莫名失败」——而断言其实全过了。
  // 因此推迟到 setImmediate：hook 立即返回，清理在后台完成；失败只告警。
  // 与 tests/closure-drill.test.ts 同一套处理。
  setImmediate(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch (err) {
      console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
    }
  });
});

describe('CheckpointService — 正常路径', () => {
  it('捕获 → list 可见 → restore 还原被修改/被删除的文件，sha256 一致', async () => {
    await writeFileIn(workspace, 'a.txt', 'hello-a');
    await writeFileIn(workspace, 'src/b.ts', 'export const b = 1;');
    const svc = makeService();

    const summary = await svc.capture(SESSION, { label: 'before-edit' });
    expect(summary.id).toMatch(/^cp_/);
    expect(summary.sessionId).toBe(SESSION);
    expect(summary.label).toBe('before-edit');
    expect(summary.fileCount).toBe(2);
    expect(summary.totalBytes).toBe('hello-a'.length + 'export const b = 1;'.length);
    expect(summary.createdAt).toBeGreaterThan(0);

    // list 可见
    const list = svc.list(SESSION);
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(summary.id);

    // 清单落库，且 sha256 与内容一致
    const manifest = readManifest(summary.id);
    expect(manifest.map((m) => m.relPath).sort()).toEqual(['a.txt', 'src/b.ts']);
    const aEntry = manifest.find((m) => m.relPath === 'a.txt');
    expect(aEntry?.sha256).toBe(sha256('hello-a'));
    expect(aEntry?.size).toBe('hello-a'.length);
    // 正文不入库：blobPath 指向 blobRoot 下的文件
    expect(aEntry?.blobPath).toBe(`${summary.id}/a.txt`);
    const blobAbs = path.join(blobRoot, ...(aEntry?.blobPath as string).split('/'));
    expect(await readFile(blobAbs, 'utf8')).toBe('hello-a');

    // 工作区被改坏：a.txt 内容变了，src/b.ts 被删了
    await writeFile(path.join(workspace, 'a.txt'), 'CORRUPTED', 'utf8');
    unlinkSync(path.join(workspace, 'src', 'b.ts'));

    const report = await svc.restore(summary.id);
    expect(report.ok).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.restored.sort()).toEqual(['a.txt', 'src/b.ts']);

    // 内容被还原，且 sha256 与快照一致
    expect(await readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('hello-a');
    expect(await readFile(path.join(workspace, 'src', 'b.ts'), 'utf8')).toBe('export const b = 1;');
    const restoredA = readManifest(summary.id).find((m) => m.relPath === 'a.txt');
    expect(restoredA?.sha256).toBe(sha256('hello-a'));
  });

  it('回滚不删快照之外的新文件（只还原快照里的文件）', async () => {
    await writeFileIn(workspace, 'keep.txt', 'v1');
    const svc = makeService();
    const summary = await svc.capture(SESSION);

    await writeFile(path.join(workspace, 'keep.txt'), 'v2', 'utf8');
    await writeFileIn(workspace, 'brand-new.txt', 'new');

    const report = await svc.restore(summary.id);
    expect(report.ok).toBe(true);
    expect(await readFile(path.join(workspace, 'keep.txt'), 'utf8')).toBe('v1');
    // 快照之外的新文件保留：回滚不是「把工作区恢复成绝对状态」
    expect(await readFile(path.join(workspace, 'brand-new.txt'), 'utf8')).toBe('new');
  });

  it('跳过目录、.git、node_modules 与隐藏目录（只落工作区内的普通文件）', async () => {
    await writeFileIn(workspace, 'src/index.ts', 'src');
    await writeFileIn(workspace, '.git/config', 'git');
    await writeFileIn(workspace, 'node_modules/pkg/index.js', 'dep');
    await writeFileIn(workspace, '.cache/tmp.bin', 'hidden');
    const svc = makeService();

    const summary = await svc.capture(SESSION);
    expect(summary.fileCount).toBe(1);
    const manifest = readManifest(summary.id);
    expect(manifest.map((m) => m.relPath)).toEqual(['src/index.ts']);
  });

  it('capture 只捕获点名的文件（files 参数）', async () => {
    await writeFileIn(workspace, 'a.txt', 'a');
    await writeFileIn(workspace, 'b.txt', 'b');
    const svc = makeService();

    const summary = await svc.capture(SESSION, { files: ['a.txt'] });
    expect(summary.fileCount).toBe(1);
    expect(readManifest(summary.id).map((m) => m.relPath)).toEqual(['a.txt']);
  });

  it('白名单模式**真的只拍白名单**：未点名的文件不进快照（不退化成全量遍历）', async () => {
    await writeFileIn(workspace, 'wanted.txt', 'w');
    await writeFileIn(workspace, 'other1.txt', 'o1');
    await writeFileIn(workspace, 'other2.txt', 'o2');
    await writeFileIn(workspace, 'deep/nested.txt', 'd');
    const svc = makeService();

    const summary = await svc.capture(SESSION, { files: ['wanted.txt', 'deep/nested.txt'] });
    expect(summary.fileCount).toBe(2);
    expect(readManifest(summary.id).map((m) => m.relPath).sort()).toEqual(['deep/nested.txt', 'wanted.txt']);
    // 未点名的文件确实没被拍进去
    const relPaths = readManifest(summary.id).map((m) => m.relPath);
    expect(relPaths).not.toContain('other1.txt');
    expect(relPaths).not.toContain('other2.txt');
  });

  it('白名单模式：files 为空数组 → 不落快照记录（不拍空快照）', async () => {
    await writeFileIn(workspace, 'a.txt', 'a');
    const svc = makeService();

    const summary = await svc.capture(SESSION, { files: [] });
    // 没有落任何记录：id 为空串 + created=false
    expect(summary.id).toBe('');
    expect(summary.created).toBe(false);
    expect(summary.fileCount).toBe(0);
    // 库里的快照数没变
    expect(svc.list(SESSION).length).toBe(0);
  });

  it('白名单模式：files 为空数组 ≠ 不传 files（不传 = 全量遍历）', async () => {
    await writeFileIn(workspace, 'a.txt', 'a');
    const svc = makeService();

    // 不传 files → 全量：a.txt 被拍到
    const full = await svc.capture(SESSION);
    expect(full.fileCount).toBe(1);
    expect(full.id).not.toBe('');
    expect(svc.list(SESSION).length).toBe(1);
  });

  it('白名单模式：点名的是**目录** → 递归展开目录下的文件（purge 场景）', async () => {
    // fs.write 的 purge 会「删掉整个目录再重建空目录」，
    // 而调用方传给白名单的是**目录路径**。若目录被直接跳过，
    // purge 就拍不到任何文件 —— 安全网在最该兜底的批量破坏操作上失效。
    await writeFileIn(workspace, 'important/a.txt', 'CRITICAL');
    await writeFileIn(workspace, 'important/deep/b.txt', 'ALSO');
    await writeFileIn(workspace, 'other.txt', 'unrelated');
    const svc = makeService();

    const summary = await svc.capture(SESSION, { files: ['important'] });
    expect(summary.fileCount).toBe(2);
    expect(summary.created).toBe(true);
    const relPaths = readManifest(summary.id).map((m) => m.relPath).sort();
    expect(relPaths).toEqual(['important/a.txt', 'important/deep/b.txt']);
    // 未点名的文件不在快照里
    expect(relPaths).not.toContain('other.txt');
  });

  it('白名单模式：目录展开后可回滚（模拟 purge 后还原）', async () => {
    await writeFileIn(workspace, 'important/a.txt', 'CRITICAL');
    const svc = makeService();
    const summary = await svc.capture(SESSION, { files: ['important'] });

    // 模拟 purge：整个目录被删掉
    rmSync(path.join(workspace, 'important'), { recursive: true, force: true });
    expect(existsSync(path.join(workspace, 'important', 'a.txt'))).toBe(false);

    const report = await svc.restore(summary.id);
    expect(report.ok).toBe(true);
    expect(report.restored).toContain('important/a.txt');
    expect(await readFile(path.join(workspace, 'important', 'a.txt'), 'utf8')).toBe('CRITICAL');
  });
});

describe('CheckpointService — 边界', () => {
  it('空工作区：0 个文件，快照仍然建立', async () => {
    const svc = makeService();
    const summary = await svc.capture(SESSION, { label: 'empty' });
    expect(summary.fileCount).toBe(0);
    expect(summary.totalBytes).toBe(0);
    expect(svc.list(SESSION).length).toBe(1);
    expect(readManifest(summary.id)).toEqual([]);
  });

  it('超 maxFiles：超出部分被跳过，且在 label 里明确体现（不静默截断）', async () => {
    await writeFileIn(workspace, 'a.txt', 'a');
    await writeFileIn(workspace, 'b.txt', 'b');
    await writeFileIn(workspace, 'c.txt', 'c');
    const svc = makeService({ maxFiles: 2 });

    const summary = await svc.capture(SESSION);
    expect(summary.fileCount).toBe(2);
    expect(summary.label).toContain('skipped');
    expect(summary.label).toContain('maxFiles');
  });

  it('超 maxBytes：超出部分被跳过，且在 label 里明确体现', async () => {
    await writeFileIn(workspace, 'small.txt', 'x'.repeat(600 * 1024));
    await writeFileIn(workspace, 'big.txt', 'y'.repeat(600 * 1024));
    const svc = makeService({ maxBytes: 1 }); // 1 MB

    const summary = await svc.capture(SESSION);
    expect(summary.fileCount).toBe(1);
    expect(summary.totalBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(summary.label).toContain('maxBytes');
  });

  it('单文件超限：整个文件被跳过（不截断内容）', async () => {
    await writeFileIn(workspace, 'huge.bin', 'z'.repeat(1024 * 1024 + 512));
    await writeFileIn(workspace, 'ok.txt', 'ok');
    const svc = makeService({ maxBytes: 1 }); // 1 MB

    const summary = await svc.capture(SESSION);
    expect(summary.fileCount).toBe(1);
    expect(readManifest(summary.id).map((m) => m.relPath)).toEqual(['ok.txt']);
    expect(summary.label).toContain('maxBytes');
  });

  it('sessionId 过滤：list 只返回本会话的快照', async () => {
    const svc = makeService();
    const a = await svc.capture('se_a', { label: 'a' });
    const b = await svc.capture('se_b', { label: 'b' });

    expect(svc.list('se_a').map((c) => c.id)).toEqual([a.id]);
    expect(svc.list('se_b').map((c) => c.id)).toEqual([b.id]);
    expect(svc.list().length).toBe(2);
  });

  it('restore 不存在的 id → 抛 CheckpointNotFoundError（不静默「成功」）', async () => {
    const svc = makeService();
    await expect(svc.restore('cp_nonexistent')).rejects.toThrow(CheckpointNotFoundError);
    await expect(svc.restore('cp_nonexistent')).rejects.toThrow(/CHECKPOINT_NOT_FOUND|快照不存在/);
  });

  it('restore 快照正文缺失 → 单文件失败不中断，其余照常回滚', async () => {
    await writeFileIn(workspace, 'a.txt', 'a');
    await writeFileIn(workspace, 'b.txt', 'b');
    const svc = makeService();
    const summary = await svc.capture(SESSION);

    // 破坏其中一个 blob（模拟正文被清掉）
    const entry = readManifest(summary.id).find((m) => m.relPath === 'a.txt');
    unlinkSync(path.join(blobRoot, ...(entry?.blobPath as string).split('/')));

    await writeFile(path.join(workspace, 'a.txt'), 'BROKEN', 'utf8');
    await writeFile(path.join(workspace, 'b.txt'), 'BROKEN', 'utf8');

    const report = await svc.restore(summary.id);
    expect(report.ok).toBe(false);
    expect(report.failed).toEqual(['a.txt']);
    expect(report.restored).toEqual(['b.txt']);
    // 失败的那个文件保持原样（不写半截内容）
    expect(await readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('BROKEN');
    expect(await readFile(path.join(workspace, 'b.txt'), 'utf8')).toBe('b');
  });
});

describe('CheckpointService — 异常与安全', () => {
  it('路径穿越（../../etc/passwd）被拒', async () => {
    await writeFileIn(outsideDir, 'secret.txt', 'TOP SECRET');
    const svc = makeService();

    await expect(svc.capture(SESSION, { files: ['../../etc/passwd'] })).rejects.toThrow(CheckpointPathError);
    await expect(svc.capture(SESSION, { files: ['../outside/secret.txt'] })).rejects.toThrow(CheckpointPathError);
    // 绝对路径同样拒绝
    await expect(svc.capture(SESSION, { files: [path.join(outsideDir, 'secret.txt')] })).rejects.toThrow(
      CheckpointPathError,
    );
    // 拒绝后没有留下快照
    expect(svc.list(SESSION).length).toBe(0);
  });

  it('符号链接指向工作区外 → 被拒，不进快照', async () => {
    const secret = path.join(outsideDir, 'secret.txt');
    await writeFile(secret, 'TOP SECRET', 'utf8');
    await symlink(secret, path.join(workspace, 'escape.txt'), 'file');
    const svc = makeService();

    const summary = await svc.capture(SESSION);
    expect(summary.fileCount).toBe(0);
    expect(readManifest(summary.id)).toEqual([]);
    expect(summary.label).toContain('symlink-escape');
    // 正文没被复制出去
    const blobDirs = await stat(blobRoot);
    expect(blobDirs.isDirectory()).toBe(true);
  });

  it('显式点名一个指向工作区外的符号链接 → 直接抛错', async () => {
    const secret = path.join(outsideDir, 'secret.txt');
    await writeFile(secret, 'TOP SECRET', 'utf8');
    await symlink(secret, path.join(workspace, 'escape.txt'), 'file');
    const svc = makeService();

    await expect(svc.capture(SESSION, { files: ['escape.txt'] })).rejects.toThrow(CheckpointPathError);
  });

  it('祖先目录是软链（指向工作区外）→ 区外文件不被拍进快照', async () => {
    // 越界读的经典形态：`ws/sub -> 工作区外目录`，则 `ws/sub/secret.txt`
    // 的 lstat 看着是**普通文件**（lstat 只解析最后一段），
    // 只有 realpath 才看得出整条链其实指向区外 —— 漏判就会把区外内容拍进快照。
    const secret = path.join(outsideDir, 'secret.txt');
    await writeFile(secret, 'TOP SECRET', 'utf8');
    await symlink(outsideDir, path.join(workspace, 'sub'), 'dir');
    await writeFileIn(workspace, 'inside.txt', 'ok');
    const svc = makeService();

    const summary = await svc.capture(SESSION);
    const relPaths = readManifest(summary.id).map((m) => m.relPath);
    expect(relPaths).not.toContain('sub/secret.txt');
    expect(relPaths).toContain('inside.txt');
    // 快照里不得出现区外内容
    for (const entry of readManifest(summary.id)) {
      const blobAbs = path.join(blobRoot, ...entry.blobPath.split('/'));
      expect(await readFile(blobAbs, 'utf8')).not.toBe('TOP SECRET');
    }
  });

  it('显式点名祖先目录软链下的区外文件 → 抛错', async () => {
    const secret = path.join(outsideDir, 'secret.txt');
    await writeFile(secret, 'TOP SECRET', 'utf8');
    await symlink(outsideDir, path.join(workspace, 'sub'), 'dir');
    const svc = makeService();

    await expect(svc.capture(SESSION, { files: ['sub/secret.txt'] })).rejects.toThrow(
      CheckpointPathError,
    );
  });

  it('点名一个指向区外的**目录**软链 → 抛错（目录展开同样要过 realpath 判定）', async () => {
    await writeFile(path.join(outsideDir, 'secret.txt'), 'TOP SECRET', 'utf8');
    await symlink(outsideDir, path.join(workspace, 'escape-dir'), 'dir');
    const svc = makeService();

    await expect(svc.capture(SESSION, { files: ['escape-dir'] })).rejects.toThrow(
      CheckpointPathError,
    );
    expect(svc.list(SESSION).length).toBe(0);
  });

  it('能力未启用：capture 抛 CheckpointDisabledError（带明确 code）', async () => {
    const svc = makeService({ enabled: false });
    try {
      await svc.capture(SESSION);
      throw new Error('capture 在未启用时不应成功');
    } catch (err) {
      expect(err).toBeInstanceOf(CheckpointDisabledError);
      expect((err as CheckpointDisabledError).code).toBe('CHECKPOINT_DISABLED');
      expect((err as CheckpointDisabledError).status).toBe(409);
    }
  });

  it('能力未启用：list 不抛异常，返回空数组语义', () => {
    const svc = makeService({ enabled: false });
    expect(() => svc.list(SESSION)).not.toThrow();
    expect(svc.list(SESSION)).toEqual([]);
    expect(svc.enabled).toBe(false);
  });

  it('能力未启用：restore 抛 CheckpointDisabledError', async () => {
    const svc = makeService({ enabled: false });
    await expect(svc.restore('cp_anything')).rejects.toThrow(CheckpointDisabledError);
  });
});

describe('CheckpointsController — 双重闸门', () => {
  function controllerFor(enabled: boolean): CheckpointsController {
    return new CheckpointsController(makeService({ enabled }));
  }

  it('GET /checkpoints：返回 enabled + checkpoints', async () => {
    await writeFileIn(workspace, 'a.txt', 'a');
    const svc = makeService();
    await svc.capture(SESSION);
    const controller = new CheckpointsController(svc);

    const res = mockRes();
    controller.list({ query: { sessionId: SESSION } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { enabled: boolean }).enabled).toBe(true);
    expect((res.body as { checkpoints: unknown[] }).checkpoints.length).toBe(1);
  });

  it('GET /checkpoints：未启用 → enabled=false + 空数组', () => {
    const controller = controllerFor(false);
    const res = mockRes();
    controller.list({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: false, checkpoints: [] });
  });

  it('POST rollback：缺确认头 → 400', async () => {
    await writeFileIn(workspace, 'a.txt', 'a');
    const svc = makeService();
    const summary = await svc.capture(SESSION);
    const controller = new CheckpointsController(svc);

    const res = mockRes();
    await controller.rollback({ params: { id: summary.id }, headers: {} } as never, res as never);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toContain('x-codelens-confirm');
  });

  it('POST rollback：确认头值不对 → 400', async () => {
    const svc = makeService();
    const summary = await svc.capture(SESSION);
    const controller = new CheckpointsController(svc);

    const res = mockRes();
    await controller.rollback(
      { params: { id: summary.id }, headers: { 'x-codelens-confirm': 'yes' } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
  });

  it('POST rollback：未启用 → 409（闸门先于确认头）', async () => {
    const controller = controllerFor(false);
    const res = mockRes();
    await controller.rollback(
      { params: { id: 'cp_x' }, headers: { 'x-codelens-confirm': 'rollback' } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      enabled: false,
      error: { code: 'CAPABILITY_DISABLED', message: 'CHECKPOINT_ENABLED 未开启' },
    });
  });

  it('POST rollback：两道闸门都过 → 200 + report', async () => {
    await writeFileIn(workspace, 'a.txt', 'a');
    const svc = makeService();
    const summary = await svc.capture(SESSION);
    await writeFile(path.join(workspace, 'a.txt'), 'BROKEN', 'utf8');
    const controller = new CheckpointsController(svc);

    const res = mockRes();
    await controller.rollback(
      { params: { id: summary.id }, headers: { 'x-codelens-confirm': 'rollback' } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { enabled: boolean; report: { ok: boolean; restored: string[] } };
    expect(body.enabled).toBe(true);
    expect(body.report.ok).toBe(true);
    expect(body.report.restored).toEqual(['a.txt']);
    expect(await readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('a');
  });

  it('POST rollback：快照不存在 → 404', async () => {
    const controller = controllerFor(true);
    const res = mockRes();
    await controller.rollback(
      { params: { id: 'cp_nonexistent' }, headers: { 'x-codelens-confirm': 'rollback' } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: { message: string } }).error.message).toContain('快照不存在');
  });
});
