/**
 * Judge API 端点测试（只读视图）。
 *
 * 除了正常返回，重点钉住两件事：
 *  - 非法/不存在的 run id 必须明确报错，不能静默返回空；
 *  - 自证端点必须如实暴露「L2/L3 未实现」，不能让前端以为判据塔已完备。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { SessionRepository } from '../src/services/memory/session.repository.js';
import { ToolCallRepository } from '../src/services/memory/tool-call.repository.js';
import { JudgeService } from '../src/services/judge/judge.service.js';
import { JudgeController } from '../src/controllers/judge.controller.js';

let db: Db;
let sessions: SessionRepository;
let toolCalls: ToolCallRepository;
let judge: JudgeService;
let controller: JudgeController;

interface Captured {
  res: Response;
  status: number;
  body: any;
}

function capture(): Captured {
  const captured: Captured = {
    status: 200,
    body: undefined,
    res: undefined as unknown as Response,
  };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  };
  captured.res = res as unknown as Response;
  return captured;
}

function req(query: Record<string, unknown> = {}, params: Record<string, unknown> = {}): Request {
  return { query, params } as unknown as Request;
}

beforeEach(() => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  sessions = new SessionRepository(db);
  toolCalls = new ToolCallRepository(db);
  judge = new JudgeService({ db, toolCalls });
  controller = new JudgeController(judge);
});

let seq = 0;
function seedSuccessfulRun(): { sessionId: string; runId: number } {
  const sid = sessions.create({ provider: 'deepseek', model: 'deepseek-chat' }).id;
  seq += 1;
  const row = toolCalls.insert({
    sessionId: sid,
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
  toolCalls.markFinished(row.id, { status: 'success' });

  const run = judge.judge(sid, {
    finishReason: 'stop',
    iteration: 2,
    tokenBudget: 100_000,
    usage: { promptTokens: 10_000, completionTokens: 2_000 },
    circuitOpened: false,
  });
  return { sessionId: sid, runId: run.runId! };
}

describe('GET /judge/runs', () => {
  it('无判决时返回空列表（而不是报错）', () => {
    const c = capture();
    controller.listRuns(req(), c.res);
    expect(c.status).toBe(200);
    expect(c.body.runs).toEqual([]);
  });

  it('返回已产生的判决，字段完整', () => {
    const { sessionId, runId } = seedSuccessfulRun();
    const c = capture();
    controller.listRuns(req({ sessionId }), c.res);

    expect(c.body.runs).toHaveLength(1);
    const run = c.body.runs[0];
    expect(run.id).toBe(runId);
    expect(run.verdict).toBe('pass');
    expect(typeof run.coverage).toBe('number');
    expect(run.sessionId).toBe(sessionId);
  });

  it('limit 被夹在 1..100，非法 limit 回落默认', () => {
    seedSuccessfulRun();
    const tooBig = capture();
    controller.listRuns(req({ limit: '9999' }), tooBig.res);
    expect(tooBig.body.runs.length).toBeLessThanOrEqual(100);

    const bogus = capture();
    controller.listRuns(req({ limit: 'abc' }), bogus.res);
    expect(bogus.status).toBe(200);
    expect(bogus.body.runs).toHaveLength(1);

    const zero = capture();
    controller.listRuns(req({ limit: '0' }), zero.res);
    expect(zero.body.runs).toHaveLength(1);
  });
});

describe('GET /judge/runs/:id', () => {
  it('返回 run 与逐条判据', () => {
    const { runId } = seedSuccessfulRun();
    const c = capture();
    controller.getRun(req({}, { id: String(runId) }), c.res);

    expect(c.status).toBe(200);
    expect(c.body.run.id).toBe(runId);
    expect(Array.isArray(c.body.verdicts)).toBe(true);
    // v2：run.total 是主口径（仅 available 层），全塔条数看 towerTotal。
    expect(c.body.verdicts.length).toBe(c.body.run.towerTotal);
    expect(c.body.verdicts[0]).toHaveProperty('criterion');
    expect(c.body.verdicts[0]).toHaveProperty('status');
  });

  it('不存在的 id → 404', () => {
    const c = capture();
    controller.getRun(req({}, { id: '99999' }), c.res);
    expect(c.status).toBe(404);
    expect(c.body.error.code).toBe('JUDGE_RUN_NOT_FOUND');
  });

  it('非法 id（非正整数）→ 400', () => {
    for (const bad of ['0', '-3', 'abc', '1.5']) {
      const c = capture();
      controller.getRun(req({}, { id: bad }), c.res);
      expect(c.status).toBe(400);
      expect(c.body.error.code).toBe('INVALID_RUN_ID');
    }
  });
});

describe('GET /judge/runs/:id：证据脱敏', () => {
  it('默认只回证据摘要，?include=evidence 才回原文', () => {
    const { runId } = seedSuccessfulRun();

    const plain = capture();
    controller.getRun(req({}, { id: String(runId) }), plain.res);
    const plainContext = JSON.stringify(plain.body.run.context);
    expect(plainContext).not.toContain('display_name');
    expect(plain.body.run.context.evidence).toEqual({
      digest: expect.any(String),
      toolCallCount: 1,
      approvalCount: 0,
      truncated: false,
    });
    expect(plain.body.run.context.evidence.digest).toMatch(/^[0-9a-f]{64}$/);

    const full = capture();
    controller.getRun(req({ include: 'evidence' }, { id: String(runId) }), full.res);
    const fullContext = JSON.stringify(full.body.run.context);
    expect(fullContext).toContain('display_name');
    expect(full.body.run.context.evidence.toolCalls).toHaveLength(1);
  });

  it('selfcheck 下发覆盖率门槛（前端不再硬编码 0.6）', () => {
    const c = capture();
    controller.selfCheck(req(), c.res);
    expect(c.body.coverageThreshold).toBe(0.6);
  });
});

describe('GET /judge/selfcheck', () => {
  it('金丝雀通过，且如实声明 L2/L3 未实现', () => {
    const c = capture();
    controller.selfCheck(req(), c.res);

    expect(c.status).toBe(200);
    expect(c.body.canary.status).toBe('pass');
    expect(c.body.unimplementedLayers.map((l: { layer: string }) => l.layer)).toEqual(['L2', 'L3']);
    expect(c.body.thresholds).toHaveProperty('minToolSuccessRate');
  });

  it('totalRuns 反映真实判决数（不是常量）', () => {
    const before = capture();
    controller.selfCheck(req(), before.res);
    expect(before.body.totalRuns).toBe(0);

    seedSuccessfulRun();

    const after = capture();
    controller.selfCheck(req(), after.res);
    expect(after.body.totalRuns).toBe(1);
  });
});

describe('GET /judge/effectiveness', () => {
  it('无注入记录时返回空数组', () => {
    const c = capture();
    controller.effectiveness(req(), c.res);
    expect(c.status).toBe(200);
    expect(c.body.lessons).toEqual([]);
  });

  it('注入过的经验能带回有效性字段', () => {
    const { sessionId } = seedSuccessfulRun();
    judge.recordInjections(sessionId, 1, ['经验甲']);

    const c = capture();
    controller.effectiveness(req(), c.res);
    const row = c.body.lessons.find((l: { lesson: string }) => l.lesson === '经验甲');
    expect(row).toBeDefined();
    expect(row.injected).toBe(1);
    expect(row.passRate).toBe(1);
  });
});
