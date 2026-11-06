/**
 * 强化内核洞察视图的验收。
 *
 * 这个端点存在的意义是「让内核可被看见」，所以它的用例重点不是「返回了 200」，
 * 而是三件容易被做错的事：
 *  1. **只读**：调用前后所有表逐字节不变。它是唯一一个会碰「深判花费」和「π 注入」
 *     这些敏感数据的读端点，一旦顺手写点什么，整个闭环的数据就不可信了。
 *  2. **有界**：深判花费只能靠解压 context_json 得到，必须证明扫描上界真的生效
 *     （最旧的那几条不能偷偷被算进来）。
 *  3. **口径不骗人**：null 覆盖率不能显示成 0、「一次深判 = 一行 = 一个样本」不能
 *     被读成「被深判的原判决数」。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { encodeSnapshot } from '../src/services/judge/snapshot-codec.js';

let runtime: Runtime;
let server: http.Server;
let base: string;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'codelens-insight-'));
  runtime = createRuntime({ dbPath: path.join(tmpRoot, 'insight.db') });
  const app = createApp({ runtime, autoStartModelSync: false });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await runtime.close();
  const dir = tmpRoot;
  setImmediate(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
    }
  });
});

/** 造一条判决行。`deep` 存在时快照里带 deep 块（模拟深判行）。 */
function insertRun(opts: {
  verdict: 'pass' | 'fail' | 'inconclusive';
  parentRun?: number | null;
  deep?: {
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    latencyMs?: number;
    failure?: string | null;
  };
  layerCoverage?: Record<string, number | null>;
}): number {
  const snapshot = {
    coverageVersion: 2,
    judgeVersion: { rules: 'criterion-set-v2', coverage: 2, assessor: opts.deep ? 'llm.judge-v1' : 'rules.v1' },
    profiles: [],
    unavailableLayers: [],
    towerCoverage: 1,
    towerExecuted: 1,
    towerTotal: 1,
    layerCoverage: opts.layerCoverage ?? { L0: 1, L1: 1, L2: 1, L3: null },
    thresholds: { minToolSuccessRate: 0.6, maxApprovalRejectionRate: 0.5, maxBudgetUsageRate: 0.9 },
    context: { finishReason: 'stop', iteration: 1, tokenBudget: 100000, usage: { promptTokens: 10, completionTokens: 5 }, circuitOpened: false },
    canary: { status: 'pass', goodScore: 1, badScore: 0 },
    evidence: { digest: 'd', truncated: false },
    semantic: null,
    evidenceDigest: 'd',
    ...(opts.deep
      ? {
          deep: {
            assessorId: 'llm.judge-v1',
            promptTemplateVersion: 1,
            provider: { providerId: 'custom', model: opts.deep.model ?? 'fake-model', baseUrlHost: 'x', keySource: 'client', modelSource: 'request' },
            temperature: 0,
            usage: { promptTokens: opts.deep.promptTokens ?? 0, completionTokens: opts.deep.completionTokens ?? 0 },
            latencyMs: opts.deep.latencyMs ?? 0,
            failure: opts.deep.failure ?? null,
          },
        }
      : {}),
  };

  const result = runtime.db.run(
    `INSERT INTO judge_runs (session_id, verdict, score, coverage, executed, total, context_json, created_at, parent_run)
     VALUES (?, ?, 0.5, 1, 8, 8, ?, ?, ?)`,
    ['s', opts.verdict, encodeSnapshot(snapshot), Date.now(), opts.parentRun ?? null],
  );
  return Number(result.lastInsertRowid);
}

async function getInsight(query = ''): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/v1/judge/insight${query}`);
  return { status: res.status, body: await res.json() };
}

describe('GET /judge/insight', () => {
  it('K1 空库 ⇒ 各块为零值，四层清单仍恒为 4 条', async () => {
    const res = await getInsight();
    expect(res.status).toBe(200);
    expect(res.body.layers.items).toHaveLength(4);
    expect(res.body.layers.items.map((i: any) => i.layer)).toEqual(['L0', 'L1', 'L2', 'L3']);
    expect(res.body.distribution.rules.runs).toBe(0);
    expect(res.body.distribution.deep.runs).toBe(0);
    expect(res.body.deepUsage.totalTokens).toBe(0);
    expect(res.body.errors).toEqual([]);
    // 没有快照时覆盖率必须是 null，不能是 0 —— 「没测」和「测出 0%」是两件事。
    expect(res.body.layers.items.every((i: any) => i.lastRunCoverage === null)).toBe(true);
  });

  it('K2 两档分别计数，每档三态之和等于该档行数', async () => {
    insertRun({ verdict: 'pass' });
    insertRun({ verdict: 'fail' });
    insertRun({ verdict: 'inconclusive' });
    const parent = insertRun({ verdict: 'pass' });
    insertRun({ verdict: 'fail', parentRun: parent, deep: { promptTokens: 10, completionTokens: 5 } });
    insertRun({ verdict: 'pass', parentRun: parent, deep: { promptTokens: 20, completionTokens: 5 } });

    const res = await getInsight();
    expect(res.body.distribution.rules.runs).toBe(4);
    expect(res.body.distribution.deep.runs).toBe(2);
    expect(res.body.distribution.unit).toBe('row');

    const { rules, deep } = res.body.distribution;
    expect(rules.pass + rules.fail + rules.inconclusive).toBe(rules.runs);
    expect(deep.pass + deep.fail + deep.inconclusive).toBe(deep.runs);
    expect(res.body.distribution.totalRuns).toBe(6);
  });

  it('K3 同一原判决被深判两次 ⇒ 按行计 2 次，但覆盖的原判决只算 1', async () => {
    const parent = insertRun({ verdict: 'fail' });
    insertRun({ verdict: 'fail', parentRun: parent, deep: { promptTokens: 1, completionTokens: 1 } });
    insertRun({ verdict: 'pass', parentRun: parent, deep: { promptTokens: 1, completionTokens: 1 } });

    const res = await getInsight();
    expect(res.body.distribution.deep.runs).toBe(2);
    expect(res.body.distribution.deep.coveredOriginals).toBe(1);
    expect(res.body.distribution.deep.repeatParents).toBe(1);
  });

  it('K4 深判花费有界扫描：只算最近 200 条，最旧的再大也不计入', async () => {
    // 先插 5 条「很贵」的旧深判，再插 200 条便宜的。合计 205 条。
    for (let i = 0; i < 5; i += 1) {
      insertRun({ verdict: 'fail', parentRun: 1, deep: { promptTokens: 1000, completionTokens: 1000 } });
    }
    for (let i = 0; i < 200; i += 1) {
      insertRun({ verdict: 'pass', parentRun: 1, deep: { promptTokens: 1, completionTokens: 1 } });
    }

    const res = await getInsight();
    expect(res.body.window.deepScanLimit).toBe(200);
    expect(res.body.window.deepScanned).toBe(200);
    expect(res.body.window.deepTruncated).toBe(true);
    // 只算最近 200 条便宜的：200 × (1 + 1) = 400；若把 5 条贵的算进来会是 10400。
    expect(res.body.deepUsage.totalTokens).toBe(400);
    expect(res.body.deepUsage.rowsWithUsage).toBe(200);
  });

  it('K5 注入视图与 getInjectableView 逐字段一致', async () => {
    // 造一条经验：一次失败判决会产出 π 版本
    const sessionId = 'sess-insight';
    const now = Date.now();
    runtime.db.run(
      `INSERT INTO sessions (id, title, provider, model, channel_mode, degraded, message_count, total_tokens, created_at, updated_at)
       VALUES (?, 'k5', 'custom', 'm', 'auto', 0, 2, 0, ?, ?)`,
      [sessionId, now, now],
    );
    runtime.db.run(
      `INSERT INTO messages (id, session_id, seq, role, content, tokens, is_summary, created_at)
       VALUES ('k5-u', ?, 1, 'user', '写个文件', 10, 0, ?)`,
      [sessionId, now],
    );
    runtime.db.run(
      `INSERT INTO messages (id, session_id, seq, role, content, tokens, is_summary, created_at)
       VALUES ('k5-a', ?, 2, 'assistant', '已创建 a.txt', 10, 0, ?)`,
      [sessionId, now],
    );
    const judged = runtime.judge.judge(sessionId, {
      finishReason: 'stop',
      iteration: 1,
      tokenBudget: 100000,
      usage: { promptTokens: 10, completionTokens: 5 },
      circuitOpened: false,
    });
    // 声称创建但无工具证据 ⇒ L3 fail ⇒ 产生经验
    runtime.policy.applyFromJudge(judged, judged.runId!);

    const view = runtime.policy.getInjectableView();
    const budget = runtime.policy.getInjectionBudget();
    const res = await getInsight();

    expect(res.body.injection).not.toBeNull();
    expect(res.body.injection.version).toBe(view.version);
    expect(res.body.injection.lessons).toEqual(view.lessons);
    expect(res.body.injection.evicted).toEqual(view.evicted);
    expect(res.body.injection.chars).toBe(view.chars);
    expect(res.body.injection.policyLessons).toBe(runtime.policy.getPolicy().lessons.length);
    expect(res.body.injection.budget).toEqual({ maxLessons: budget.maxLessons, maxChars: budget.maxChars });
  });

  it('K6 只读：调用前后所有表逐字节不变', async () => {
    const parent = insertRun({ verdict: 'fail' });
    insertRun({ verdict: 'pass', parentRun: parent, deep: { promptTokens: 5, completionTokens: 5 } });

    const dump = (): string =>
      JSON.stringify([
        runtime.db.all('SELECT * FROM judge_runs ORDER BY id'),
        runtime.db.all('SELECT * FROM judge_verdicts ORDER BY id'),
        runtime.db.all('SELECT * FROM policy_versions ORDER BY id'),
        runtime.db.all('SELECT * FROM policy_injections ORDER BY id'),
      ]);

    const before = dump();
    const res = await getInsight();
    expect(res.status).toBe(200);
    expect(dump()).toBe(before);
  });

  it('K7 limit 越界被 clamp，缺省与非数字回落到默认值', async () => {
    expect((await getInsight('?limit=0')).body.window.limit).toBe(1);
    expect((await getInsight('?limit=999')).body.window.limit).toBe(200);
    expect((await getInsight('?limit=abc')).body.window.limit).toBe(50);
    expect((await getInsight()).body.window.limit).toBe(50);
    expect((await getInsight('?limit=7')).body.window.limit).toBe(7);
  });

  it('K8 未接线 policy 时 injection 为 null，其余块照常', () => {
    const result = runtime.judge.insight({ limit: 50 });
    expect(result.injection).toBeNull();
    expect(result.layers.items).toHaveLength(4);
    expect(result.errors).toEqual([]);
  });
});
