/**
 * `/api/rsi/overview` 的结构化评测读数。
 *
 * 背景：看板此前只能从 `task.test_pass_rate` 的 detail 文本里正则抠「21/23 通过」，
 * 文案一改前端就断。这里锁住新增字段的行为：
 *  1. 老行（data_json 为 NULL）必须退化成 `source: 'detail_only'`，数值为 null ——
 *     不能为了「有数」编一个 0 出来；
 *  2. 新行必须原样透出 passed/total/denominator 与套件清单；
 *  3. 新旧混排时取**最新的结构化行**，而不是最新一行；
 *  4. 脏 JSON 不能让整条看板 500；
 *  5. 既有字段（judgeRuns / verdictsByRun / rsiRuns / attributions）一个都不能少。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

const SESSION_ID = 'sess-overview-001';

let runtime: Runtime;
let server: http.Server;
let base: string;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'codelens-overview-'));
  runtime = createRuntime({ dbPath: path.join(tmpRoot, 'overview.db') });
  const app = createApp({ runtime, autoStartModelSync: false });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const now = Date.now();
  runtime.db.run(
    `INSERT INTO sessions (id, title, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [SESSION_ID, 'overview', 'custom', 'm', now, now],
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await runtime.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function insertRun(verdict: 'pass' | 'fail' | 'inconclusive' = 'fail'): number {
  return Number(
    runtime.db.run(
      `INSERT INTO judge_runs (session_id, verdict, score, coverage, executed, total, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [SESSION_ID, verdict, 0.5, 0.7, 5, 7, Date.now()],
    ).lastInsertRowid,
  );
}

function insertEvalVerdict(
  runId: number,
  opts: { detail: string; dataJson: string | null; status?: string; score?: number },
): void {
  runtime.db.run(
    `INSERT INTO judge_verdicts (run_id, session_id, layer, criterion, status, score, detail, data_json, created_at)
     VALUES (?, ?, 'L1', 'task.test_pass_rate', ?, ?, ?, ?, ?)`,
    [runId, SESSION_ID, opts.status ?? 'fail', opts.score ?? 0.345, opts.detail, opts.dataJson, Date.now()],
  );
}

async function overview(): Promise<any> {
  const res = await fetch(`${base}/api/rsi/overview?session=${SESSION_ID}`);
  expect(res.status).toBe(200);
  return res.json();
}

describe('/api/rsi/overview 结构化评测读数', () => {
  it('旧行没有 data_json 时退化为 detail_only，不编造数值', async () => {
    const runId = insertRun();
    insertEvalVerdict(runId, {
      detail: '固定评测套件 21/23 通过（含隐藏用例）',
      dataJson: null,
    });

    const body = await overview();
    // 既有字段必须原样在（向后兼容）
    expect(Array.isArray(body.judgeRuns)).toBe(true);
    expect(body.verdictsByRun[String(runId)]).toHaveLength(1);
    expect(body.verdictsByRun[String(runId)][0].detail).toContain('21/23');
    expect(Array.isArray(body.rsiRuns)).toBe(true);
    expect(Array.isArray(body.attributions)).toBe(true);

    expect(body.eval).toMatchObject({
      runId,
      status: 'fail',
      source: 'detail_only',
      passed: null,
      total: null,
      denominator: null,
      suites: [],
    });
    expect(body.eval.detail).toContain('21/23');
  });

  it('新行透出 passed/total/denominator 与套件清单', async () => {
    const runId = insertRun();
    const suites = [
      { id: 'slugify', title: 'slugify', ok: false, passed: 0, total: 7, publicPassed: 0, publicTotal: 2 },
      { id: 'json_patch', title: 'JSON 补丁', ok: false, passed: 5, total: 16, publicPassed: 2, publicTotal: 2 },
    ];
    insertEvalVerdict(runId, {
      detail: '固定评测套件 38/110 通过（含隐藏用例）',
      dataJson: JSON.stringify({ passed: 38, total: 110, denominator: 110, score: 0.345, suites }),
    });

    const body = await overview();
    expect(body.eval).toMatchObject({
      runId,
      source: 'structured',
      passed: 38,
      total: 110,
      denominator: 110,
      score: 0.345,
    });
    expect(body.eval.suites).toHaveLength(2);
    expect(body.eval.suites[1]).toMatchObject({ id: 'json_patch', passed: 5, total: 16 });
    // 逐条判决也要带上 data，前端不必须走顶层汇总
    expect(body.verdictsByRun[String(runId)][0].data.passed).toBe(38);
  });

  it('新旧混排时取最新的结构化行', async () => {
    const oldRun = insertRun();
    insertEvalVerdict(oldRun, { detail: '旧口径 21/23 通过', dataJson: null });
    const newRun = insertRun();
    insertEvalVerdict(newRun, {
      detail: '新口径 38/110 通过',
      dataJson: JSON.stringify({ passed: 38, total: 110, denominator: 110, score: 0.345, suites: [] }),
    });
    const laterLegacy = insertRun();
    insertEvalVerdict(laterLegacy, { detail: '更晚的一般判决', dataJson: null });

    const body = await overview();
    expect(body.eval.runId).toBe(newRun);
    expect(body.eval.denominator).toBe(110);
  });

  it('脏 JSON 不把接口打成 500', async () => {
    const runId = insertRun();
    insertEvalVerdict(runId, { detail: '固定评测套件 1/2 通过', dataJson: '{not-json' });

    const body = await overview();
    expect(body.eval.source).toBe('detail_only');
    expect(body.eval.passed).toBeNull();
  });
});
