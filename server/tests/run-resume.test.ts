/**
 * C · 断点续跑：sha256 强校验 + 以最后一步为界不重放已完成调用。
 *  - 正常：磁盘一致 → ok + plan
 *  - 冲突：人为改坏 → 409 语义 + 不写盘（sha 前后一致）
 *  - 恢复：改回内容 → 再次 ok，且 run 能正常收尾
 *  - 金丝雀：无文件改动 / 无冲突时不得误报
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { CheckpointService } from '../src/services/tx/checkpoint.service.js';
import { RunStateService } from '../src/services/agent/run-state.service.js';
import { RunResumeService } from '../src/services/agent/run-resume.service.js';

const TMP_PREFIX = path.join(tmpdir(), 'codelens-resume-');

let db: Db;
let base: string;
let workspace: string;
let blobRoot: string;

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(workspace, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

function makeRunState(): RunStateService {
  // everyRun 关闭：本用例只验证 run 状态与续跑，不依赖汇报卡启用。
  return new RunStateService(db);
}

function makeCheckpoints(): CheckpointService {
  return new CheckpointService({
    db,
    sandboxRoot: workspace,
    enabled: true,
    maxFiles: 0,
    maxBytes: 0,
    blobRoot,
  });
}

beforeEach(async () => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  base = await mkdtemp(TMP_PREFIX);
  workspace = path.join(base, 'workspace');
  blobRoot = path.join(base, 'blobs');
  await mkdir(workspace, { recursive: true });
  await mkdir(blobRoot, { recursive: true });
});

afterEach(() => {
  db.close();
  setImmediate(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  });
});

describe('C · RunResumeService', () => {
  it('正常恢复：磁盘一致 → ok，且从最后一步的第一条调用重做（不重放已完成步骤）', async () => {
    const runs = makeRunState();
    const ckpt = makeCheckpoints();
    const resume = new RunResumeService(runs, ckpt);

    await write('a.txt', 'v1');
    await ckpt.capture('se', { runId: 'run_ok', step: 1, toolCallIds: ['c1'] });
    await write('a.txt', 'v2');
    await ckpt.captureAfter('run_ok', 1);

    await write('b.txt', 'b1');
    await ckpt.capture('se', { runId: 'run_ok', step: 2, toolCallIds: ['c2'] });
    await write('b.txt', 'b2');
    await ckpt.captureAfter('run_ok', 2);

    runs.start({ runId: 'run_ok', sessionId: 'se', provider: 'nvidia', model: 'm', channel: 'native' });
    runs.tool('run_ok', {
      callId: 'c1',
      name: 'fs.write',
      iteration: 1,
      status: 'success',
      startedAt: Date.now(),
      durationMs: 10,
      risk: 'high',
      approvalMode: 'hard',
      effectReversible: false,
      resultSummary: 'wrote a.txt',
      errorCode: null,
    });
    runs.tool('run_ok', {
      callId: 'c2',
      name: 'fs.write',
      iteration: 2,
      status: 'success',
      startedAt: Date.now(),
      durationMs: 10,
      risk: 'high',
      approvalMode: 'hard',
      effectReversible: false,
      resultSummary: 'wrote b.txt',
      errorCode: null,
    });

    const result = await resume.precheck('run_ok');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.plan.sessionId).toBe('se');
      expect(result.plan.step).toBe(2);
      // 最后一步的第一条调用 = c2；c1 已在更早步骤完成，不得重放。
      expect(result.plan.resumeFromCallId).toBe('c2');
    }
  });

  it('冲突：人为改坏一个文件 → 返回冲突且不写盘（sha 前后一致）', async () => {
    const runs = makeRunState();
    const ckpt = makeCheckpoints();
    const resume = new RunResumeService(runs, ckpt);

    await write('a.txt', 'v1');
    await ckpt.capture('se', { runId: 'run_bad', step: 1, toolCallIds: ['c1'] });
    await write('a.txt', 'v2');
    await ckpt.captureAfter('run_bad', 1);
    runs.start({ runId: 'run_bad', sessionId: 'se', provider: 'nvidia', model: 'm', channel: 'native' });

    // 用户/别的进程改坏了文件
    await write('a.txt', 'user-edit');
    const before = sha256(await readFile(path.join(workspace, 'a.txt'), 'utf8'));

    const result = await resume.precheck('run_bad');
    expect(result.status).toBe('conflict');
    if (result.status === 'conflict') {
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].path).toBe('a.txt');
      expect(result.conflicts[0].expectedSha256).toBe(sha256('v2'));
      expect(result.conflicts[0].actualSha256).toBe(sha256('user-edit'));
      expect(result.conflicts[0].step).toBe(1);
      expect(result.conflicts[0].checkpointId).toMatch(/^cp_/);
    }

    // 产品没有写盘：冲突前后文件 sha 完全一致，用户改动未被覆盖。
    const after = sha256(await readFile(path.join(workspace, 'a.txt'), 'utf8'));
    expect(after).toBe(before);
    expect(after).toBe(sha256('user-edit'));
  });

  it('冲突修复后再次恢复 → ok，且 run 能正常收尾', async () => {
    const runs = makeRunState();
    const ckpt = makeCheckpoints();
    const resume = new RunResumeService(runs, ckpt);

    await write('a.txt', 'v1');
    await ckpt.capture('se', { runId: 'run_fix', step: 1, toolCallIds: ['c1'] });
    await write('a.txt', 'v2');
    await ckpt.captureAfter('run_fix', 1);
    runs.start({ runId: 'run_fix', sessionId: 'se', provider: 'nvidia', model: 'm', channel: 'native' });
    runs.tool('run_fix', {
      callId: 'c1',
      name: 'fs.write',
      iteration: 1,
      status: 'success',
      startedAt: Date.now(),
      durationMs: 10,
      risk: 'high',
      approvalMode: 'hard',
      effectReversible: false,
      resultSummary: 'wrote a.txt',
      errorCode: null,
    });

    await write('a.txt', 'bad');
    expect((await resume.precheck('run_fix')).status).toBe('conflict');
    // 恢复为 run 记录的 after 内容
    await write('a.txt', 'v2');
    expect((await resume.precheck('run_fix')).status).toBe('ok');

    const report = runs.finish('run_fix', 'ok', 'stop', { promptTokens: 10, completionTokens: 2 });
    expect(report).not.toBeNull();
    expect(report!.outcome).toBe('completed');
  });

  it('金丝雀：无已改动文件时不得报冲突', async () => {
    const runs = makeRunState();
    const ckpt = makeCheckpoints();
    const resume = new RunResumeService(runs, ckpt);
    runs.start({ runId: 'run_empty', sessionId: 'se', provider: 'nvidia', model: 'm', channel: 'native' });

    const result = await resume.precheck('run_empty');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.plan.resumeFromCallId).toBeNull();
      expect(result.plan.step).toBeNull();
    }
  });
});
