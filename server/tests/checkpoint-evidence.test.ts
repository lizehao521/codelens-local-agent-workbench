/**
 * 证据链（run 级）自证：真实走一遍「改坏 → 定位步骤 → 撤销 → 校验一致」。
 *
 * 覆盖：
 *  - before/after 同一条记录：before sha256、after sha256、行级 diff；
 *  - 按 run 查询：哪一步、哪些 toolCallIds、改了哪个文件；
 *  - 按 step / 按文件 / 整 run 三种撤销粒度；
 *  - 撤销留痕：restored_at + restore_json 可在同一行读到；
 *  - 保留策略 20 run / 200 MB：最老 run 被淘汰（行保留、正文标记 pruned），pinned 不动。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { CheckpointService } from '../src/services/tx/checkpoint.service.js';

let db: Db;
let base: string;
let workspace: string;
let service: CheckpointService;

const SESSION = 'se_evidence';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

beforeEach(async () => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  base = await mkdtemp(path.join(tmpdir(), 'codelens-evidence-'));
  workspace = path.join(base, 'ws');
  await mkdir(workspace, { recursive: true });
  service = new CheckpointService({
    db,
    sandboxRoot: workspace,
    enabled: true,
    maxFiles: 0,
    maxBytes: 0,
    blobRoot: path.join(base, 'blobs'),
  });
});

afterEach(async () => {
  db.close();
  await rm(base, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(workspace, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

describe('证据链：改坏 → 定位步骤 → 撤销 → 校验一致', () => {
  it('before/after 同一条记录、按 run 查步骤与 diff、按 step 撤销', async () => {
    await write('a.txt', 'A1\nA2\n');
    await write('b.txt', 'B1\n');

    // step 1：改 a.txt
    await service.capture(SESSION, { files: ['a.txt'], runId: 'run_1', step: 1, toolCallIds: ['call_a'] });
    await write('a.txt', 'A1\nA2-changed\n');

    // step 2：改 b.txt
    await service.capture(SESSION, { files: ['b.txt'], runId: 'run_1', step: 2, toolCallIds: ['call_b'] });
    await write('b.txt', 'B1-changed\n');

    const after1 = await service.captureAfter('run_1', 1, { files: ['a.txt'] });
    const after2 = await service.captureAfter('run_1', 2, { files: ['b.txt'] });
    expect(after1?.files[0].added).toBeGreaterThan(0);
    expect(after1?.files[0].afterSha256).toBe(sha256('A1\nA2-changed\n'));
    expect(after1?.files[0].diff).toContain('A2-changed');
    expect(after2?.files[0].afterSha256).toBe(sha256('B1-changed\n'));

    // 按 run 查：两步、两个文件、来源调用都能对上。
    const evidence = service.getRun('run_1');
    expect(evidence.steps).toHaveLength(2);
    expect(evidence.steps.map((s) => s.step)).toEqual([1, 2]);
    expect(evidence.steps[0].toolCallIds).toEqual(['call_a']);
    expect(evidence.steps[0].files[0].path).toBe('a.txt');
    expect(evidence.fileCount).toBe(2);

    // 只撤销 step 2：b 还原，a 仍是改坏后的值。
    const partial = await service.restoreRun('run_1', { step: 2 });
    expect(partial.restored).toEqual(['b.txt']);
    expect(await readFile(path.join(workspace, 'b.txt'), 'utf8')).toBe('B1\n');
    expect(await readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('A1\nA2-changed\n');

    // 整 run 撤销：a 也还原，sha256 与 before 一致。
    const full = await service.restoreRun('run_1');
    expect(full.ok).toBe(true);
    expect(await readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('A1\nA2\n');
    expect(sha256(await readFile(path.join(workspace, 'a.txt'), 'utf8'))).toBe(after1?.files[0].beforeSha256);

    // 撤销留痕：两条快照都有 restored_at 与 restore_json（可审计）。
    const rows = db.all<{ id: string; restored_at: number | null; restore_json: string | null }>(
      'SELECT id, restored_at, restore_json FROM workspace_checkpoints WHERE run_id = ?',
      ['run_1'],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.restored_at).not.toBeNull();
      expect(row.restore_json).toContain('"restored"');
    }
  });

  it('按文件撤销：只回填点名文件，其余保持现状', async () => {
    await write('a.txt', 'A\n');
    await write('b.txt', 'B\n');
    await service.capture(SESSION, { files: ['a.txt', 'b.txt'], runId: 'run_2', step: 1 });
    await write('a.txt', 'A-broken\n');
    await write('b.txt', 'B-broken\n');

    const report = await service.restoreRun('run_2', { files: ['a.txt'] });
    expect(report.restored).toEqual(['a.txt']);
    expect(await readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('A\n');
    expect(await readFile(path.join(workspace, 'b.txt'), 'utf8')).toBe('B-broken\n');
  });

  it('新建文件：审计可查、续跑可校验、撤销可删除', async () => {
    // 执行前文件不存在 → capture 拍不到；执行后由 captureAfter 补 create 记录。
    await service.capture(SESSION, { files: ['new.txt'], runId: 'run_new', step: 1, toolCallIds: ['call_new'] });
    await write('new.txt', 'hello\nworld\n');
    const after = await service.captureAfter('run_new', 1, {
      files: ['new.txt'],
      createdFiles: ['new.txt'],
      sessionId: SESSION,
      toolCallIds: ['call_new'],
    });

    expect(after).not.toBeNull();
    expect(after!.files).toHaveLength(1);
    expect(after!.files[0].operation).toBe('create');
    expect(after!.files[0].beforeSha256).toBeNull();
    expect(after!.files[0].afterSha256).toBe(sha256('hello\nworld\n'));
    expect(after!.files[0].diff).toContain('+hello');

    // 审计：能看到新增条目，并归到第 1 步 / 对应调用。
    const evidence = service.getRun('run_new');
    expect(evidence.steps).toHaveLength(1);
    expect(evidence.steps[0].step).toBe(1);
    expect(evidence.steps[0].toolCallIds).toEqual(['call_new']);
    expect(evidence.steps[0].files[0]).toMatchObject({ path: 'new.txt', operation: 'create' });
    expect(evidence.fileCount).toBe(1);

    // 新建文件被改坏 → 续跑校验必须报冲突（不允许静默续跑）。
    await write('new.txt', 'tampered\n');
    const conflict = await service.verifyRun('run_new');
    expect(conflict.ok).toBe(false);
    expect(conflict.conflicts[0]).toMatchObject({
      path: 'new.txt',
      expectedSha256: after!.files[0].afterSha256,
      actualSha256: sha256('tampered\n'),
      step: 1,
    });

    // 新建文件被删除 → 同样报冲突（期望有、实际缺失）。
    await rm(path.join(workspace, 'new.txt'));
    const missing = await service.verifyRun('run_new');
    expect(missing.ok).toBe(false);
    expect(missing.conflicts[0]).toMatchObject({ path: 'new.txt', actualSha256: null });

    // 恢复成 run 记录的内容后撤销：新建文件被删除。
    await write('new.txt', 'hello\nworld\n');
    const undo = await service.restoreRun('run_new');
    expect(undo.deleted).toEqual(['new.txt']);
    await expect(readFile(path.join(workspace, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('金丝雀：用户在同路径另建不同内容 → 撤销不得误删', async () => {
    await service.capture(SESSION, { files: ['created.txt'], runId: 'run_keep', step: 1 });
    await write('created.txt', 'run-created\n');
    await service.captureAfter('run_keep', 1, {
      files: ['created.txt'],
      createdFiles: ['created.txt'],
      sessionId: SESSION,
      toolCallIds: [],
    });

    // 模拟：用户后来在同路径写了新内容（不是 run 建的那份）。
    await write('created.txt', 'user-later\n');
    const undo = await service.restoreRun('run_keep');
    expect(undo.deleted).toEqual([]);
    expect(undo.kept).toEqual(['created.txt']);
    expect(await readFile(path.join(workspace, 'created.txt'), 'utf8')).toBe('user-later\n');
  });

  it('run 中删除的已有文件：撤销能恢复内容', async () => {
    await write('old.txt', 'keep-me\n');
    await service.capture(SESSION, { files: ['old.txt'], runId: 'run_del', step: 1, toolCallIds: ['call_del'] });
    await rm(path.join(workspace, 'old.txt'));
    const after = await service.captureAfter('run_del', 1, { files: ['old.txt'] });
    expect(after?.files[0]).toMatchObject({ operation: 'write', afterSha256: null });

    const undo = await service.restoreRun('run_del');
    expect(undo.restored).toEqual(['old.txt']);
    expect(await readFile(path.join(workspace, 'old.txt'), 'utf8')).toBe('keep-me\n');
  });

  it('保留策略：超过 20 run 淘汰最老；pinned 永久保留', async () => {
    // 22 个 run，每个 run 一条快照；created_at 必须严格递增，淘汰顺序才可判定。
    for (let i = 0; i < 22; i += 1) {
      await write('f.txt', `v${i}\n`);
      await service.capture(SESSION, { files: ['f.txt'], runId: `run_${String(i).padStart(2, '0')}`, step: 1 });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const oldest = service.list(SESSION);
    // 先给最老 run 的快照 pin，验证 pinned 不被淘汰。
    const firstId = db.get<{ id: string }>(
      'SELECT id FROM workspace_checkpoints WHERE run_id = ? ORDER BY created_at ASC LIMIT 1',
      ['run_00'],
    );
    expect(firstId).toBeTruthy();
    expect(service.pin(firstId!.id, true)).toBe(true);

    const result = await service.prune({ maxRuns: 20, maxBytes: 200 * 1024 * 1024 });
    expect(result.evictedRuns).toEqual(['run_01']);
    expect(result.evictedCheckpoints).toBe(1);

    const pruned = db.get<{ status: string }>(
      'SELECT status FROM workspace_checkpoints WHERE run_id = ? ORDER BY created_at ASC LIMIT 1',
      ['run_01'],
    );
    expect(pruned?.status).toBe('pruned');

    const pinned = db.get<{ status: string }>(
      'SELECT status FROM workspace_checkpoints WHERE run_id = ? ORDER BY created_at ASC LIMIT 1',
      ['run_00'],
    );
    expect(pinned?.status).toBe('active');
    expect(oldest.length).toBeGreaterThanOrEqual(22);

    // 被淘汰的 run 正文不可用：撤销会明确失败（不静默成功）。
    const restore = await service.restoreRun('run_01');
    expect(restore.ok).toBe(false);
    expect(restore.failed.some((f) => f.includes('[pruned]'))).toBe(true);
  });
});
