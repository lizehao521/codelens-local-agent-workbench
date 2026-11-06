/**
 * C 补验：续跑的 HTTP 契约（真实监听端口 + 真实 controller/服务/SQLite）。
 *
 * 为什么不直接 createApp：`CHECKPOINT_ENABLED` 在模块加载期由 env 固化，
 * 测试里改 env 会污染同 worker 的其他文件。这里只裁掉顶层 app，挂载的是
 * **生产 runs 路由与生产 RunsController**，服务层（RunState / Checkpoint /
 * RunResume）与 SQLite 均为真实实现，因此走的仍是真实 HTTP + 真实逻辑。
 *
 * 覆盖：正常续跑 / sha 冲突 / 冲突不写盘 / 修复后再续跑 / 404。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL, applyMigrations } from '../src/repositories/schema.js';
import { CheckpointService } from '../src/services/tx/checkpoint.service.js';
import { RunStateService } from '../src/services/agent/run-state.service.js';
import { RunResumeService } from '../src/services/agent/run-resume.service.js';
import { RunsController } from '../src/controllers/runs.controller.js';
import { createRunsRoutes } from '../src/routes/runs.routes.js';

const RUN_ID = 'run-http-1';
const SESSION_ID = 'sess-http-1';
const FILE = 'a.txt';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

let tmpRoot: string;
let db: Db;
let server: http.Server;
let base: string;
let checkpoints: CheckpointService;
let runs: RunStateService;

function seedRun(): void {
  runs.start({ runId: RUN_ID, sessionId: SESSION_ID, provider: 'fake', model: 'fake-model', channel: null });
  runs.tool(RUN_ID, {
    callId: 'c1',
    name: 'fs_write',
    iteration: 1,
    status: 'success',
    startedAt: Date.now(),
    durationMs: 3,
    risk: 'low',
    approvalMode: 'soft',
    effectReversible: true,
    resultSummary: 'wrote a.txt',
    errorCode: null,
    });
  runs.tool(RUN_ID, {
    callId: 'c2',
    name: 'fs_write',
    iteration: 2,
    status: 'success',
    startedAt: Date.now(),
    durationMs: 3,
    risk: 'low',
    approvalMode: 'soft',
    effectReversible: true,
    resultSummary: 'wrote a.txt again',
    errorCode: null,
  });
}

async function resume(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/v1/runs/${RUN_ID}/resume`, { method: 'POST' });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'codelens-resume-http-'));
  db = createDb(path.join(tmpRoot, 'runs.db'));
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  const workspace = path.join(tmpRoot, 'ws');
  mkdirSync(workspace, { recursive: true });

  checkpoints = new CheckpointService({
    db,
    sandboxRoot: workspace,
    enabled: true,
    maxFiles: 200,
    maxBytes: 20,
    blobRoot: path.join(tmpRoot, 'blobs'),
  });
  runs = new RunStateService(db);
  const resumeService = new RunResumeService(runs, checkpoints);

  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRunsRoutes({ runs: new RunsController(runs, checkpoints, resumeService) }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort：宿主删除守卫偶发超时不影响结论 */
  }
});

describe('C · 续跑 HTTP 契约', () => {
  it('正常续跑：200，响应体含 runId / fromStep / resumeFromCallId（只重做最后一步）', async () => {
    seedRun();
    const target = path.join(checkpoints.blobDirectory, '..', 'ws', FILE);
    writeFileSync(target, 'v1', 'utf8');
    await checkpoints.capture(SESSION_ID, { runId: RUN_ID, step: 1, toolCallIds: ['c1', 'c2'], files: [FILE] });
    writeFileSync(target, 'v2', 'utf8');
    await checkpoints.captureAfter(RUN_ID, 1, { files: [FILE] });

    const { status, body } = await resume();
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    // 最后一步是 iteration 2 → 从该步第一条 c2 重做；c1 不重放
    expect(body.plan).toMatchObject({ runId: RUN_ID, step: 2, resumeFromCallId: 'c2' });
  });

  it('sha 冲突：409 + 冲突清单（文件/期望 sha/实际 sha/步骤），且不写盘', async () => {
    seedRun();
    const target = path.join(checkpoints.blobDirectory, '..', 'ws', FILE);
    writeFileSync(target, 'v1', 'utf8');
    await checkpoints.capture(SESSION_ID, { runId: RUN_ID, step: 1, toolCallIds: ['c1'], files: [FILE] });
    writeFileSync(target, 'v2', 'utf8');
    await checkpoints.captureAfter(RUN_ID, 1, { files: [FILE] });

    // 用户/外部工具在续跑前改坏了文件
    writeFileSync(target, 'user-edit', 'utf8');
    const beforeSha = sha(readFileSync(target, 'utf8'));

    const { status, body } = await resume();
    expect(status).toBe(409);
    expect(body.status).toBe('conflict');
    expect(body.runId).toBe(RUN_ID);
    const conflicts = body.conflicts as Array<Record<string, unknown>>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      path: FILE,
      step: 1,
      expectedSha256: sha('v2'),
      actualSha256: sha('user-edit'),
    });
    // 关键：请求本身不得写盘 —— 内容与 sha 都保持用户改动后的值
    expect(readFileSync(target, 'utf8')).toBe('user-edit');
    expect(sha(readFileSync(target, 'utf8'))).toBe(beforeSha);
  });

  it('冲突修复后再续跑：200，随后能正常收尾', async () => {
    seedRun();
    const target = path.join(checkpoints.blobDirectory, '..', 'ws', FILE);
    writeFileSync(target, 'v1', 'utf8');
    await checkpoints.capture(SESSION_ID, { runId: RUN_ID, step: 1, toolCallIds: ['c1'], files: [FILE] });
    writeFileSync(target, 'v2', 'utf8');
    await checkpoints.captureAfter(RUN_ID, 1, { files: [FILE] });

    writeFileSync(target, 'broken', 'utf8');
    expect((await resume()).status).toBe(409);

    writeFileSync(target, 'v2', 'utf8');
    const { status, body } = await resume();
    expect(status).toBe(200);
    expect(body.status).toBe('ok');

    runs.finish(RUN_ID, 'ok', 'stop', { promptTokens: 10, completionTokens: 5 });
    const getRes = await fetch(`${base}/api/v1/runs/${RUN_ID}`);
    expect(getRes.status).toBe(200);
    const payload = (await getRes.json()) as { state: { status: string }; report: { outcome: string } };
    expect(payload.state.status).toBe('ok');
    expect(payload.report.outcome).toBe('completed');
  });

  it('run 不存在：404', async () => {
    const res = await fetch(`${base}/api/v1/runs/does-not-exist/resume`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('not_found');
  });
});
