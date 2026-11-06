/**
 * D · 审计台数据面判别性用例：
 *  - 快照落库后修改磁盘 → audit 仍显示历史 diff（来自 diff_json）；
 *  - 对照：以「当前磁盘」为基线重新 capture/captureAfter → diff 为空。
 * 两条同时成立，才能证明产品没有用当前磁盘重算。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { CheckpointService } from '../src/services/tx/checkpoint.service.js';
import { RunStateService } from '../src/services/agent/run-state.service.js';
import { RunResumeService } from '../src/services/agent/run-resume.service.js';
import { RunsController } from '../src/controllers/runs.controller.js';

const TMP_PREFIX = path.join(tmpdir(), 'codelens-audit-');

let db: Db;
let base: string;
let workspace: string;
let blobRoot: string;

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(workspace, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

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
  await mkdir(workspace, { recursive: true });
  await mkdir(blobRoot, { recursive: true });
});

afterEach(() => {
  db.close();
  setImmediate(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});

describe('D · 审计台（diff 只认快照）', () => {
  it('改坏磁盘后 audit 仍显示历史 diff；当前磁盘基线对照为空', async () => {
    const ckpt = new CheckpointService({
      db,
      sandboxRoot: workspace,
      enabled: true,
      maxFiles: 0,
      maxBytes: 0,
      blobRoot,
    });
    const runs = new RunStateService(db);
    const resume = new RunResumeService(runs, ckpt);
    const controller = new RunsController(runs, ckpt, resume);

    await write('a.txt', 'v1\n');
    await ckpt.capture('se', { runId: 'run_audit', step: 1, toolCallIds: ['c1'] });
    await write('a.txt', 'v2\n');
    await ckpt.captureAfter('run_audit', 1);

    runs.start({ runId: 'run_audit', sessionId: 'se', provider: 'nvidia', model: 'm', channel: 'native' });
    runs.tool('run_audit', {
      callId: 'c1',
      name: 'fs.write',
      iteration: 1,
      status: 'success',
      startedAt: Date.now(),
      durationMs: 10,
      risk: 'medium',
      approvalMode: 'soft',
      effectReversible: true,
      resultSummary: 'wrote a.txt',
      errorCode: null,
    });

    // 事后用户又把文件改成了 v3
    await write('a.txt', 'v3\n');

    const res = mockRes();
    controller.audit({ params: { runId: 'run_audit' } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      steps: Array<{ files: Array<{ path: string; diff: string; step: number; checkpointId: string; toolCallIds: string[] }> }>;
      undo: { runAvailable: boolean };
    };
    const file = body.steps[0].files[0];
    expect(file.path).toBe('a.txt');
    expect(file.diff).toContain('-v1');
    expect(file.diff).toContain('+v2');
    // hunk 来源可回溯
    expect(file.step).toBe(1);
    expect(file.checkpointId).toMatch(/^cp_/);
    expect(file.toolCallIds).toEqual(['c1']);
    expect(body.undo.runAvailable).toBe(true);

    // 对照：以「当前磁盘」（v3）为基线再做一次 capture/captureAfter → 空 diff。
    await ckpt.capture('se', { runId: 'run_control', step: 1 });
    await ckpt.captureAfter('run_control', 1);
    const control = ckpt.getRun('run_control');
    expect(control.steps[0].files[0].diff).toBe('');
  });

  it('run 不存在 → 404', () => {
    const ckpt = new CheckpointService({
      db,
      sandboxRoot: workspace,
      enabled: true,
      maxFiles: 0,
      maxBytes: 0,
      blobRoot,
    });
    const runs = new RunStateService(db);
    const resume = new RunResumeService(runs, ckpt);
    const controller = new RunsController(runs, ckpt, resume);
    const res = mockRes();
    controller.audit({ params: { runId: 'nope' } } as never, res as never);
    expect(res.statusCode).toBe(404);
  });
});
