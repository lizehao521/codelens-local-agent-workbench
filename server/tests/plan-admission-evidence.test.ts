/**
 * 残留①判据：collectEvidence 给 JudgeEvidence.planAdmission 填真实生产证据，
 * 让第6条判据 planAdmissionL0 在真实 run 里从恒 unexec 变成可执行。
 *
 * 钉住四件事：
 *  1. 无活跃条目 / 无 fs.write → undefined（诚实 unexec，不编造）；
 *  2. 有活跃条目 + fs.write → 返回完整证据（items/activeItemId/requestedItemId/operation）；
 *  3. 多条 fs.write 取最后一条（run 级单值确定）；
 *  4. 集成：judge 跑一次后，第6条 verdict 不再是 unexec。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { SessionRepository } from '../src/services/memory/session.repository.js';
import { ToolCallRepository } from '../src/services/memory/tool-call.repository.js';
import { PlanRepository } from '../src/repositories/plan.repository.js';
import { JudgeService } from '../src/services/judge/judge.service.js';
import { collectPlanAdmissionEvidence } from '../src/services/judge/plan-admission-evidence.js';

let db: Db;
let sessions: SessionRepository;
let toolCalls: ToolCallRepository;
let judge: JudgeService;
let seq = 0;

beforeEach(() => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  sessions = new SessionRepository(db);
  toolCalls = new ToolCallRepository(db);
  judge = new JudgeService({ db, toolCalls });
  seq = 0;
});

function newSession(): string {
  return sessions.create({ provider: 'custom', model: 'm' }).id;
}

function seedPlan(sessionId: string, status: 'draft' | 'approved' | 'running' = 'approved'): string {
  db.run(
    `INSERT OR IGNORE INTO sessions (id, title, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [sessionId, 't', 'custom', 'm', 1, 1],
  );
  const id = `plan-${sessionId}`;
  new PlanRepository(db).insert({
    id, sessionId, runId: null, title: 't', status, stepsJson: '[]', createdAt: 1, updatedAt: 1,
  });
  return id;
}

function addWrite(sessionId: string, planItemId: string | null, operation = 'create', createdAt = 100): void {
  seq += 1;
  const args = JSON.stringify({ path: 'a.txt', operation, ...(planItemId ? { planItemId } : {}) });
  toolCalls.insert({
    sessionId, messageId: null, callId: `c-${seq}`,
    toolName: 'fs.write', toolWireName: 'fs_write', displayName: '写入',
    category: 'file', source: 'builtin', risk: 'medium', approvalMode: 'soft', channel: 'native',
    iteration: 1, argsJson: args, argsDigest: `d-${seq}`,
  });
  // created_at 由 insert 内部取 Date.now；这里直接覆写以控制"最后一条"顺序。
  db.run('UPDATE tool_calls SET created_at = ?, status = ? WHERE call_id = ?', [createdAt, 'success', `c-${seq}`]);
}

describe('collectPlanAdmissionEvidence · 生产证据派生', () => {
  it('无活跃条目 → undefined（诚实 unexec）', () => {
    const sid = newSession();
    addWrite(sid, 'whatever');
    expect(collectPlanAdmissionEvidence(db, sid)).toBeUndefined();
  });

  it('有活跃条目但本轮无 fs.write → undefined', () => {
    const sid = newSession();
    seedPlan(sid, 'approved');
    expect(collectPlanAdmissionEvidence(db, sid)).toBeUndefined();
  });

  it('只有 draft 条目 → undefined（draft 不算活跃）', () => {
    const sid = newSession();
    seedPlan(sid, 'draft');
    addWrite(sid, 'plan-x');
    expect(collectPlanAdmissionEvidence(db, sid)).toBeUndefined();
  });

  it('有活跃条目 + fs.write → 完整证据', () => {
    const sid = newSession();
    const id = seedPlan(sid, 'approved');
    addWrite(sid, id, 'overwrite');
    const ev = collectPlanAdmissionEvidence(db, sid);
    expect(ev).toBeDefined();
    expect(ev!.items).toEqual([{ id, status: 'approved' }]);
    expect(ev!.activeItemId).toBe(id);
    expect(ev!.requestedItemId).toBe(id);
    expect(ev!.operation).toBe('overwrite');
    expect(ev!.toolName).toBe('fs.write');
  });

  it('多条 fs.write → 取最后一条（created_at 最大）', () => {
    const sid = newSession();
    const id = seedPlan(sid, 'running');
    addWrite(sid, id, 'create', 100);
    addWrite(sid, `${id}-wrong`, 'replace', 200);
    const ev = collectPlanAdmissionEvidence(db, sid);
    expect(ev!.requestedItemId).toBe(`${id}-wrong`);
    expect(ev!.operation).toBe('replace');
  });

  it('fs.write 未声明 planItemId → requestedItemId=null（判据据此 fail，不编造）', () => {
    const sid = newSession();
    seedPlan(sid, 'approved');
    addWrite(sid, null);
    const ev = collectPlanAdmissionEvidence(db, sid);
    expect(ev!.requestedItemId).toBeNull();
  });
});

describe('judge 集成 · 第6条判据吃到生产证据', () => {
  const runtime = {
    finishReason: 'stop', iteration: 3, tokenBudget: 100000,
    usage: { promptTokens: 20000, completionTokens: 5000 }, circuitOpened: false,
  };

  it('有活跃条目 + 匹配的 fs.write → 第6条不再是 unexec，且为 pass', () => {
    const sid = newSession();
    const id = seedPlan(sid, 'approved');
    addWrite(sid, id, 'create');
    const run = judge.judge(sid, runtime);
    const v = run.verdicts.find((x) => x.criterion === 'plan.admission');
    expect(v).toBeDefined();
    expect(v!.status).toBe('pass');
  });

  it('有活跃条目 + 不匹配的 planItemId → 第6条为 fail', () => {
    const sid = newSession();
    seedPlan(sid, 'approved');
    addWrite(sid, 'wrong-id', 'create');
    const run = judge.judge(sid, runtime);
    const v = run.verdicts.find((x) => x.criterion === 'plan.admission');
    expect(v!.status).toBe('fail');
  });

  it('无计划上下文 → 第6条仍 unexec（向后兼容，没证据不假判）', () => {
    const sid = newSession();
    const run = judge.judge(sid, runtime);
    const v = run.verdicts.find((x) => x.criterion === 'plan.admission');
    expect(v!.status).toBe('unexec');
  });
});
