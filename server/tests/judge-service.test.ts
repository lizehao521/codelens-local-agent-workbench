/**
 * JudgeService 集成测试：从真实 τ（DB 里的 tool_calls / approvals）产出判决 r。
 *
 * 重点验证两件事：
 *  1. coverage 门槛生效 —— 「没测够」只能 inconclusive，不能 pass；
 *  2. fail 优先于 coverage —— 失败不能被低覆盖率稀释掉。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { SessionRepository } from '../src/services/memory/session.repository.js';
import { ToolCallRepository } from '../src/services/memory/tool-call.repository.js';
import { JudgeService } from '../src/services/judge/judge.service.js';
import { summarize } from '../src/services/judge/judge.service.js';
import { decodeSnapshot } from '../src/services/judge/snapshot-codec.js';
import { COVERAGE_THRESHOLD, type CriterionVerdict } from '../src/services/judge/types.js';

let db: Db;
let sessions: SessionRepository;
let toolCalls: ToolCallRepository;
let judge: JudgeService;

beforeEach(() => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  sessions = new SessionRepository(db);
  toolCalls = new ToolCallRepository(db);
  judge = new JudgeService({ db, toolCalls });
});

function newSession(): string {
  return sessions.create({ provider: 'deepseek', model: 'deepseek-chat' }).id;
}

let seq = 0;
function addToolCall(sessionId: string, status: 'success' | 'failed' | 'timeout' | 'rejected', name = 'fs.read') {
  seq += 1;
  const row = toolCalls.insert({
    sessionId,
    messageId: null,
    callId: `call-${seq}`,
    toolName: name,
    toolWireName: name,
    displayName: name,
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

function addApproval(sessionId: string, toolCallId: string, decision: 'allow_once' | 'reject') {
  db.run(
    `INSERT INTO approvals (id, session_id, tool_call_id, tool_name, args_digest, challenge_token_hash,
                            status, decision, expires_at, decided_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'decided', ?, ?, ?, ?)`,
    [`ap-${seq++}`, sessionId, toolCallId, 'fs.read', 'd', 'h', decision, Date.now() + 1000, Date.now(), Date.now()],
  );
}

const baseRuntime = {
  finishReason: 'stop',
  iteration: 3,
  tokenBudget: 100_000,
  usage: { promptTokens: 20_000, completionTokens: 5_000 },
  circuitOpened: false,
};

describe('JudgeService.judge', () => {
  it('正常任务：无 fail 且 coverage 达标 → pass', () => {
    const sid = newSession();
    addToolCall(sid, 'success');
    const run = judge.judge(sid, baseRuntime);

    expect(run.verdict).toBe('pass');
    expect(run.coverage).toBeGreaterThanOrEqual(COVERAGE_THRESHOLD);
    expect(run.verdicts.some((v) => v.status === 'fail')).toBe(false);
  });

  it('工具全线失败且迭代耗尽 → fail', () => {
    const sid = newSession();
    addToolCall(sid, 'failed');
    addToolCall(sid, 'failed');
    const run = judge.judge(sid, { ...baseRuntime, finishReason: 'max_iterations', iteration: 12 });

    expect(run.verdict).toBe('fail');
    const failed = run.verdicts.filter((v) => v.status === 'fail').map((v) => v.criterion);
    expect(failed).toContain('tool.success_rate');
    expect(failed).toContain('task.terminal');
  });

  it('证据不足（无工具、无审批、无预算）→ inconclusive，绝不 pass', () => {
    const sid = newSession();
    const run = judge.judge(sid, {
      finishReason: 'stop',
      iteration: 1,
      tokenBudget: 0,
      usage: { promptTokens: 0, completionTokens: 0 },
      circuitOpened: false,
    });

    expect(run.verdict).toBe('inconclusive');
    expect(run.coverage).toBeLessThan(COVERAGE_THRESHOLD);
    expect(run.verdicts.filter((v) => v.status === 'unexec').length).toBeGreaterThan(0);
  });

  it('fail 优先于 coverage：覆盖不足也挡不住已发现的失败', () => {
    const sid = newSession();
    addToolCall(sid, 'failed');
    const run = judge.judge(sid, {
      finishReason: 'max_iterations',
      iteration: 12,
      tokenBudget: 0,
      usage: { promptTokens: 0, completionTokens: 0 },
      circuitOpened: false,
    });

    // v2：覆盖率分母只算 available 层，这条场景的主口径覆盖是 4/6≈0.667，
    // 不再"因为分母里塞了恒不执行的 L2/L3 而看起来覆盖不足"。
    // 因此这里断言的重点回到它本来该证明的事：fail 不被任何覆盖率稀释。
    expect(run.verdict).toBe('fail');
    expect(run.verdicts.some((v) => v.status === 'unexec')).toBe(true);
  });

  it('真正的低覆盖（必需层没跑）→ inconclusive，绝不是 pass', () => {
    const sid = newSession();
    // 只有终止性可判：无工具、无审批、无预算 → L0 五条里三条不可执行。
    const run = judge.judge(sid, {
      finishReason: 'stop',
      iteration: 1,
      tokenBudget: 0,
      usage: { promptTokens: 0, completionTokens: 0 },
      circuitOpened: false,
    });

    expect(run.verdict).toBe('inconclusive');
    expect(run.reasons.length).toBeGreaterThan(0);
    expect(run.requiredGaps.length).toBeGreaterThan(0);
  });

  it('熔断终止 → loop.health 与 task.terminal 同时判 fail', () => {
    const sid = newSession();
    addToolCall(sid, 'timeout');
    addToolCall(sid, 'failed');
    const run = judge.judge(sid, { ...baseRuntime, finishReason: 'circuit_open', circuitOpened: true });

    const failed = run.verdicts.filter((v) => v.status === 'fail').map((v) => v.criterion);
    expect(failed).toContain('loop.health');
    expect(failed).toContain('task.terminal');
  });

  it('审批大量被拒 → approval.friction fail', () => {
    const sid = newSession();
    const c1 = addToolCall(sid, 'rejected');
    const c2 = addToolCall(sid, 'rejected');
    const c3 = addToolCall(sid, 'success');
    addApproval(sid, c1, 'reject');
    addApproval(sid, c2, 'reject');
    addApproval(sid, c3, 'allow_once');

    const run = judge.judge(sid, baseRuntime);
    const friction = run.verdicts.find((v) => v.criterion === 'approval.friction');
    expect(friction?.status).toBe('fail');
  });

  it('L2/L3 未实现时如实标 unexec，不用绿字掩盖', () => {
    const sid = newSession();
    addToolCall(sid, 'success');
    const run = judge.judge(sid, baseRuntime);

    for (const layer of ['L2', 'L3'] as const) {
      const v = run.verdicts.find((x) => x.layer === layer);
      expect(v?.status).toBe('unexec');
      expect(v?.detail).toBeTruthy();
    }
  });
});

describe('判决落库（r 可追溯）', () => {
  it('一次判决写入 1 行 run + N 行 verdict，且能按 session 查回', () => {
    const sid = newSession();
    addToolCall(sid, 'success');
    const run = judge.judge(sid, baseRuntime);

    const runs = judge.repository.listRuns({ sessionId: sid });
    expect(runs).toHaveLength(1);
    expect(runs[0].verdict).toBe(run.verdict);
    expect(runs[0].coverage).toBeCloseTo(run.coverage, 3);

    const verdicts = judge.repository.listVerdicts(runs[0].id);
    // total 是主口径（仅 available 层进分母）；落库的逐条判据是全塔条数。
    expect(verdicts).toHaveLength(run.towerTotal);
    expect(run.total).toBeLessThan(run.towerTotal);
    expect(verdicts.map((v) => v.criterion)).toContain('tool.success_rate');
  });

  it('context_json 保留运行期上下文，便于复盘', () => {
    const sid = newSession();
    addToolCall(sid, 'success');
    judge.judge(sid, baseRuntime);
    const row = judge.repository.listRuns({ sessionId: sid })[0];
    // v2：context_json 以 gz: 前缀压缩存储，必须走 decodeSnapshot 读（解码兼容旧明文行）。
    const ctx = decodeSnapshot(row.context_json) as { finishReason: string; iteration: number };
    expect(ctx.finishReason).toBe('stop');
    expect(ctx.iteration).toBe(3);
  });

  it('按判据聚合的历史分布可查（判据塔自证的数据面）', () => {
    const sid = newSession();
    addToolCall(sid, 'success');
    judge.judge(sid, baseRuntime);

    const stats = judge.repository.criterionStats();
    const tool = stats.find((s) => s.criterion === 'tool.success_rate');
    expect(tool?.pass).toBe(1);
    expect(tool?.total).toBe(1);
  });
});

describe('JudgeService.selfCheck', () => {
  it('金丝雀在本机判据下通过，并声明未实现的层', () => {
    const report = judge.selfCheck();
    expect(report.canary.verdict.status).toBe('pass');
    expect(report.unimplementedLayers.map((l) => l.layer)).toEqual(['L2', 'L3']);
    expect(report.totalRuns).toBe(0);
  });
});

describe('summarize 定档规则', () => {
  const mk = (status: CriterionVerdict['status'], n = 1): CriterionVerdict[] =>
    Array.from({ length: n }, (_, i) => ({
      layer: 'L0' as const,
      criterion: `c${i}`,
      status,
    }));

  it('全 pass 且覆盖充足 → pass', () => {
    // v2：L1 是 required 层，「没有 L1 结论」本身就是必需层缺口。
    // 所以"全绿"必须包含金丝雀结论，否则 pass 就绕过了自证（缺陷 D 的另一面）。
    const verdicts: CriterionVerdict[] = [
      ...mk('pass', 10),
      { layer: 'L1', criterion: 'canary.discrimination', status: 'pass' },
    ];
    expect(summarize(verdicts).verdict).toBe('pass');
  });

  it('只有 L0 全绿、缺 L1 结论 → inconclusive（必需层缺口的 fail-closed）', () => {
    const s = summarize(mk('pass', 10));
    expect(s.verdict).toBe('inconclusive');
    expect(s.reasons).toContain('required_layer_unexecuted');
    expect(s.requiredGaps.some((g) => g.layer === 'L1')).toBe(true);
  });

  it('全 pass 但覆盖不足 → inconclusive', () => {
    const verdicts = [...mk('pass', 2), ...mk('unexec', 8)];
    const s = summarize(verdicts);
    expect(s.coverage).toBe(0.2);
    expect(s.verdict).toBe('inconclusive');
  });

  it('存在 fail 时，即使覆盖不足也判 fail', () => {
    const verdicts = [...mk('fail', 1), ...mk('unexec', 9)];
    expect(summarize(verdicts).verdict).toBe('fail');
  });

  it('空判据集 → coverage 0、inconclusive（不把「什么都没测」当通过）', () => {
    const s = summarize([]);
    expect(s.coverage).toBe(0);
    expect(s.verdict).toBe('inconclusive');
  });
});
