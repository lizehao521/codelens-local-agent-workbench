/**
 * 判决复算（判据塔 v2 缺陷 C 的回归夹具）。
 *
 * 缺陷 C 的本质：v1 的 context_json 只有 runtime + 两个金丝雀分数，
 * 于是「这条 fail 怎么判出来的」事后无法回答，只能被相信、不能被检验。
 *
 * 这一组测试要证明三件事：
 *  1. replay 只读且幂等（两次调用逐字节相同，judge_runs 行数不变）；
 *  2. 证据漂移不改变复算结论（用快照，不重读现况），但必须被标记出来；
 *  3. 用的是**快照里的阈值**，不是现在的 π —— 否则 π 一自我修改，历史判决集体变心。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { SessionRepository } from '../src/services/memory/session.repository.js';
import { ToolCallRepository } from '../src/services/memory/tool-call.repository.js';
import { JudgeService } from '../src/services/judge/judge.service.js';
import { JudgeController } from '../src/controllers/judge.controller.js';
import { UpdateService } from '../src/services/agent/update.service.js';
import { L0_CRITERIA, DEFAULT_L0_THRESHOLDS, resolveThresholds } from '../src/services/judge/criteria.js';
import { parseContextSnapshot, type JudgeReplayResult } from '../src/services/judge/replay.js';
import { encodeSnapshot, decodeSnapshot, GZ_PREFIX } from '../src/services/judge/snapshot-codec.js';
import { ruleSemanticAssessor } from '../src/services/judge/semantic.js';

let db: Db;
let sessions: SessionRepository;
let toolCalls: ToolCallRepository;
let judge: JudgeService;
let controller: JudgeController;

interface Captured {
  status: number;
  body: any;
  res: Response;
}

function capture(): Captured {
  const c: Captured = { status: 200, body: undefined, res: undefined as unknown as Response };
  c.res = {
    status(code: number) {
      c.status = code;
      return this;
    },
    json(payload: unknown) {
      c.body = payload;
      return this;
    },
  } as unknown as Response;
  return c;
}

function req(query: Record<string, unknown> = {}, params: Record<string, unknown> = {}): Request {
  return { query, params } as unknown as Request;
}

beforeEach(() => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  sessions = new SessionRepository(db);
  toolCalls = new ToolCallRepository(db);
  judge = new JudgeService({ db, toolCalls, semantic: ruleSemanticAssessor });
  controller = new JudgeController(judge);
});

function newSession(): string {
  return sessions.create({ provider: 'deepseek', model: 'deepseek-chat' }).id;
}

let seq = 0;
function addToolCall(sessionId: string, status: 'success' | 'failed'): string {
  seq += 1;
  const row = toolCalls.insert({
    sessionId,
    messageId: null,
    callId: `call-${seq}`,
    toolName: 'fs.read',
    toolWireName: 'fs.read',
    displayName: '读取文件',
    category: 'file',
    source: 'builtin',
    risk: 'low',
    approvalMode: 'none',
    channel: 'native',
    iteration: 1,
    argsJson: '{}',
    argsDigest: `digest-${seq}`,
  });
  toolCalls.markFinished(row.id, { status });
  return row.id;
}

const runtime = {
  finishReason: 'stop',
  iteration: 3,
  tokenBudget: 100_000,
  usage: { promptTokens: 20_000, completionTokens: 5_000 },
  circuitOpened: false,
};

function seedRun(): { sessionId: string; runId: number } {
  const sid = newSession();
  addToolCall(sid, 'success');
  const run = judge.judge(sid, runtime);
  return { sessionId: sid, runId: run.runId! };
}

function replayViaHttp(runId: number, evidence?: string): Captured {
  const c = capture();
  controller.replay(req(evidence ? { evidence } : {}, { id: String(runId) }), c.res);
  return c;
}

describe('A12：replay 只读且幂等', () => {
  it('两次调用 body 完全一致，judge_runs 行数不变，outcome=reproduced', () => {
    const { runId } = seedRun();
    const runsBefore = judge.repository.countRuns();

    const first = replayViaHttp(runId);
    const second = replayViaHttp(runId);

    expect(first.status).toBe(200);
    expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body));

    const body = first.body as JudgeReplayResult;
    expect(body.outcome).toBe('reproduced');
    expect(body.reproduced).toBe(true);
    expect(body.diffs).toEqual([]);
    expect(body.evidence.drifted).toBe(false);
    expect(body.judgeVersion?.rules).toBe('criterion-set-v2');
    expect(body.recorded.coverageVersion).toBe(2);

    // 只读：判决行数、判据行数都没变（全塔 12 条 = L0×5 + 工具纪律×4 + L1 + L2 + L3）
    expect(judge.repository.countRuns()).toBe(runsBefore);
    expect(judge.repository.listVerdicts(runId)).toHaveLength(12);
  });

  it('非法 id → 400；不存在的 id → 404；evidence 参数非法时回落 snapshot', () => {
    const bad = replayViaHttp(0);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_RUN_ID');

    const missing = replayViaHttp(99999);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('JUDGE_RUN_NOT_FOUND');

    const { runId } = seedRun();
    const bogus = replayViaHttp(runId, 'whatever');
    expect(bogus.status).toBe(200);
    expect(bogus.body.evidence.source).toBe('snapshot');
  });
});

describe('A13：证据漂移不改变复算结论，但必须被标记', () => {
  it('判决后把 tool_calls 改成 failed → 仍 reproduced，但 drifted=true', () => {
    const { sessionId, runId } = seedRun();

    db.run(`UPDATE tool_calls SET status = 'failed' WHERE session_id = ?`, [sessionId]);

    const body = replayViaHttp(runId).body as JudgeReplayResult;
    expect(body.outcome).toBe('reproduced');
    expect(body.evidence.drifted).toBe(true);
    expect(body.evidence.snapshotDigest).not.toBe(body.evidence.currentDigest);
  });

  it('current 证据源仅作对照：结论仍由快照决定', () => {
    const { sessionId, runId } = seedRun();
    db.run(`UPDATE tool_calls SET status = 'failed' WHERE session_id = ?`, [sessionId]);

    const body = replayViaHttp(runId, 'current').body as JudgeReplayResult;
    expect(body.evidence.source).toBe('current');
    expect(body.evidence.drifted).toBe(true);
    // 即便现况看起来更糟，reproduced 仍只按快照判定
    expect(body.outcome).toBe('reproduced');
  });
});

describe('A14：旧行 / 无快照 → unreproducible，且 HTTP 200', () => {
  it('手插没有 evidence 的 run → unreproducible + evidence_not_snapshotted + 200', () => {
    const sid = newSession();
    db.run(
      `INSERT INTO judge_runs (session_id, verdict, score, coverage, executed, total, context_json, created_at)
       VALUES (?, 'pass', 1, 1, 8, 8, ?, ?)`,
      [sid, JSON.stringify({ finishReason: 'stop', iteration: 1 }), Date.now()],
    );
    const row = judge.repository.listRuns({ sessionId: sid })[0]!;

    const c = replayViaHttp(row.id);
    expect(c.status).toBe(200);
    expect(c.body.outcome).toBe('unreproducible');
    expect(c.body.reproduced).toBe(false);
    expect(c.body.reasons).toContain('evidence_not_snapshotted');
    expect(c.body.recorded.coverageVersion).toBe(1);
    expect(c.body.recomputed).toBeNull();
  });
});

describe('A15：复算用快照阈值，不重读 π，也不用编译期默认值', () => {
  it('快照阈值 0.7 ≠ 默认 0.6 ≠ 现值 0.95，replay 仍 reproduced', () => {
    const policy = new UpdateService(db, judge.repository);
    judge.setThresholdsProvider(() => policy.getPolicy().thresholds);

    // 段 1：先把 π 的闸拧到 0.7 —— 快照必须记住 0.7
    policy.applyUpdate({ setThresholds: { minToolSuccessRate: 0.7 } });

    // 2 成功 + 1 失败 = 0.667：0.7 下必然 fail（同时也确保这条 run 的真值不是「默认 0.6 的 pass」）
    const sid = newSession();
    addToolCall(sid, 'success');
    addToolCall(sid, 'success');
    addToolCall(sid, 'failed');
    const run = judge.judge(sid, runtime);
    const recorded = run.verdicts.find((v) => v.criterion === 'tool.success_rate');
    expect(recorded?.status).toBe('fail');

    // 段 2：判决之后再改 π 到 0.95 —— 现值必须与快照不同
    policy.applyUpdate({ setThresholds: { minToolSuccessRate: 0.95 } });
    expect(policy.getPolicy().thresholds.minToolSuccessRate).toBe(0.95);

    const snapshot = parseContextSnapshot(judge.repository.getRun(run.runId!)!.context_json)!;
    expect(snapshot.thresholds.minToolSuccessRate).toBe(0.7);
    expect(snapshot.thresholds.minToolSuccessRate).not.toBe(DEFAULT_L0_THRESHOLDS.minToolSuccessRate);

    // 反证：三段阈值下这条判据的结论不同 —— 0.7 与 0.95 判 fail，默认 0.6 判 pass。
    // 只要 replay 悄悄用了「当前 π」或「编译期默认」，结论就会翻转成 mismatch。
    const evidence = snapshot.evidence as Parameters<(typeof L0_CRITERIA)[number]>[0];
    const at = (minToolSuccessRate: number) => L0_CRITERIA[0](evidence, resolveThresholds({ minToolSuccessRate })).status;
    expect(at(0.7)).toBe('fail');
    expect(at(0.95)).toBe('fail');
    expect(at(DEFAULT_L0_THRESHOLDS.minToolSuccessRate)).toBe('pass');

    const after = replayViaHttp(run.runId!).body as JudgeReplayResult;
    expect(after.outcome).toBe('reproduced');
    expect(after.recomputed?.verdict).toBe(after.recorded.verdict);
    // 快照里的 0.7 既不等于默认值也不等于现值，reproduced 只能来自「读快照」
    expect(after.judgeVersion?.rules).toBe('criterion-set-v2');
  });
});

describe('A15-b：三个阈值落在三个不同结论上（抓「读当前 π」与「读默认值」两个突变方向）', () => {
  it('快照 0.7（fail）/ 现值 0.5（pass）/ 默认 0.6（pass）—— replay 只能 reproduced', () => {
    const policy = new UpdateService(db, judge.repository);
    judge.setThresholdsProvider(() => policy.getPolicy().thresholds);

    // 段 1：π = 0.7 时判决。成功率 2/3=0.667 < 0.7 ⇒ 该判据 fail、run fail
    policy.applyUpdate({ setThresholds: { minToolSuccessRate: 0.7 } });
    const sid = newSession();
    addToolCall(sid, 'success');
    addToolCall(sid, 'success');
    addToolCall(sid, 'failed');
    const run = judge.judge(sid, runtime);
    expect(run.verdicts.find((v) => v.criterion === 'tool.success_rate')?.status).toBe('fail');
    expect(run.verdict).toBe('fail');

    // 段 2：判决之后把 π 改到 0.5 —— 现值下同一条证据会判 pass
    policy.applyUpdate({ setThresholds: { minToolSuccessRate: 0.5 } });
    expect(policy.getPolicy().thresholds.minToolSuccessRate).toBe(0.5);

    const after = replayViaHttp(run.runId!).body as JudgeReplayResult;
    expect(after.outcome).toBe('reproduced');
    // diffs 为空 = 逐条判据（含 tool.success_rate）status 全等 ⇒ 重算仍是 fail
    expect(after.diffs).toEqual([]);
    expect(after.recomputed?.verdict).toBe('fail');

    // 对照组：同一份证据在三个阈值下结论互不相同
    const snapshot = parseContextSnapshot(judge.repository.getRun(run.runId!)!.context_json)!;
    expect(snapshot.thresholds.minToolSuccessRate).toBe(0.7);
    const evidence = snapshot.evidence as Parameters<(typeof L0_CRITERIA)[number]>[0];
    const at = (minToolSuccessRate: number) => L0_CRITERIA[0](evidence, resolveThresholds({ minToolSuccessRate })).status;
    expect(at(0.7)).toBe('fail'); // 快照值
    expect(at(0.5)).toBe('pass'); // 现值（读现值就变 mismatch）
    expect(at(DEFAULT_L0_THRESHOLDS.minToolSuccessRate)).toBe('pass'); // 默认值（读默认就变 mismatch）
  });
});

describe('快照编码：自适应压缩且向后兼容旧明文行', () => {
  it('编码后再解码得到深度相等的对象', () => {
    const snapshot = {
      coverageVersion: 2,
      judgeVersion: { rules: 'criterion-set-v2', coverage: 2, assessor: 'rules.v1' },
      layerCoverage: { L0: 0.8, L1: 1, L2: null, L3: null },
      canary: { status: 'pass', goodScore: 1, badScore: 0 },
      evidence: { toolCalls: [{ status: 'success', display_name: '读取文件' }], approvals: [] },
      semantic: { assessorId: 'rules.v1', evidence: { goal: '统计行数', finalAnswer: '共 42 行' } },
    };
    expect(decodeSnapshot(encodeSnapshot(snapshot))).toEqual(snapshot);
    expect(encodeSnapshot(snapshot).startsWith(GZ_PREFIX)).toBe(true);
  });

  it('旧明文行（无 gz: 前缀）仍能读；坏数据返回 null 而不是抛', () => {
    const plain = JSON.stringify({ coverageVersion: 1, finishReason: 'stop' });
    expect(decodeSnapshot(plain)).toEqual({ coverageVersion: 1, finishReason: 'stop' });
    expect(decodeSnapshot('gz:not-base64!!')).toBeNull();
    expect(decodeSnapshot(null)).toBeNull();
  });

  it('16K 中文快照压缩后长度 < 原文的 0.6 倍', () => {
    const goal = '请解释敏捷开发中的冲刺计划与迭代评审的差异，并说明各自的产出物。'.repeat(400).slice(0, 16_000);
    const snapshot = {
      coverageVersion: 2,
      semantic: { assessorId: 'rules.v1', evidence: { goal, finalAnswer: goal } },
    };
    const plainLength = JSON.stringify(snapshot).length;
    const encodedLength = encodeSnapshot(snapshot).length;

    expect(plainLength).toBeGreaterThan(16_000);
    expect(encodedLength).toBeLessThan(plainLength * 0.6);
  });

  it('典型轨迹仍走压缩（< 原文 0.7 倍），且能解码回等值对象', () => {
    const snapshot = {
      coverageVersion: 2,
      thresholds: { minToolSuccessRate: 0.6, maxApprovalRejectionRate: 0.5, maxBudgetUsageRate: 0.9 },
      evidence: {
        toolCalls: Array.from({ length: 150 }, (_, i) => ({
          status: i % 7 === 0 ? 'failed' : 'success',
          display_name: '读取文件',
          error_kind: i % 7 === 0 ? 'PATH_OUTSIDE_SANDBOX' : null,
        })),
        approvals: Array.from({ length: 40 }, () => ({ status: 'decided', decision: 'allow_once' })),
      },
    };
    const encoded = encodeSnapshot(snapshot);
    const plainBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');

    expect(encoded.startsWith(GZ_PREFIX)).toBe(true);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThan(plainBytes * 0.7);
    expect(decodeSnapshot(encoded)).toEqual(snapshot);
  });

  it('不可压缩内容（随机 base64 高熵文本）存明文，绝不比原文更大', () => {
    // 用 sha256 链生成确定性高熵文本（等价于 JWT/二进制转储转 base64 的形态）：
    // gzip 几乎压不动（0.758），base64 再 ×1.33 ⇒ 1.010×，压了反而更大。
    let text = '';
    for (let i = 0; i < 800; i += 1) text += createHash('sha256').update(`seed${i}`).digest('base64');
    const snapshot = { coverageVersion: 2, semantic: { assessorId: 'rules.v1', evidence: { goal: text } } };
    const plain = JSON.stringify(snapshot);
    const encoded = encodeSnapshot(snapshot);

    expect(encoded.startsWith(GZ_PREFIX)).toBe(false);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(Buffer.byteLength(plain, 'utf8'));
    expect(decodeSnapshot(encoded)).toEqual(snapshot);
  });
});
