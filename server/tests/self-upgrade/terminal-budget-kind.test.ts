/**
 * Judge · budget_exhausted 必须按真实预算种类出 detail。
 *
 * 线上 g3 是 wall_clock（471721/180000ms）耗尽，旧判据却固定写
 * “token 预算耗尽而任务未完成”。这让复盘归因到错误的资源，也掩盖了
 * 审批等待跨过 wall-clock 的问题。
 */
import { describe, expect, it } from 'vitest';
import { taskTerminal, DEFAULT_L0_THRESHOLDS } from '../../src/services/judge/criteria.js';
import type { JudgeEvidence } from '../../src/services/judge/types.js';
import { JudgeService } from '../../src/services/judge/judge.service.js';
import { createDb } from '../../src/repositories/db.js';
import { SCHEMA_SQL } from '../../src/repositories/schema.js';
import { SessionRepository } from '../../src/services/memory/session.repository.js';
import { ToolCallRepository } from '../../src/services/memory/tool-call.repository.js';

const base: JudgeEvidence = {
  sessionId: 'sess-budget',
  finishReason: 'budget_exhausted',
  iteration: 3,
  tokenBudget: 256_000,
  usage: { promptTokens: 20_000, completionTokens: 1_000 },
  toolCalls: [],
  approvals: [],
  circuitOpened: false,
};

const run = (over: Record<string, unknown>) =>
  taskTerminal({ ...base, ...over } as unknown as JudgeEvidence, DEFAULT_L0_THRESHOLDS);

describe('task.terminal · budget_exhausted 按真实预算种类出 detail', () => {
  it('wall_clock：写墙钟毫秒，不得写成 token', () => {
    const v = run({ budgetKind: 'wall_clock', budgetLimit: 180_000, budgetUsed: 471_721 });
    expect(v.status).toBe('fail');
    expect(v.detail).toContain('墙钟预算耗尽');
    expect(v.detail?.includes('墙钟预算耗尽')).toBe(true);
    expect(v.detail).toContain('471721/180000');
    expect(v.detail).toContain('ms');
    expect(v.detail!.includes('token 预算')).toBe(false);
  });

  it('tokens：写 token 用量', () => {
    const v = run({ budgetKind: 'tokens', budgetLimit: 256_000, budgetUsed: 267_980 });
    expect(v.status).toBe('fail');
    expect(v.detail).toContain('token 预算耗尽');
    expect(v.detail).toContain('267980/256000');
    expect(v.detail!.includes('墙钟预算')).toBe(false);
  });

  it('tool_calls：写工具调用次数', () => {
    const v = run({ budgetKind: 'tool_calls', budgetLimit: 40, budgetUsed: 40 });
    expect(v.status).toBe('fail');
    expect(v.detail).toContain('工具调用次数预算耗尽');
    expect(v.detail).toContain('40/40');
    expect(v.detail!.includes('token 预算')).toBe(false);
  });

  it('缺预算种类：诚实标未记录，不猜 token', () => {
    const v = run({});
    expect(v.status).toBe('fail');
    expect(v.detail).toContain('预算种类未记录');
    expect(v.detail!.includes('token 预算耗尽')).toBe(false);
  });

  it('非 budget_exhausted 不受影响', () => {
    expect(taskTerminal({ ...base, finishReason: 'stop' }, DEFAULT_L0_THRESHOLDS).detail).toBe('模型正常结束输出');
  });

  it('JudgeService 真实链路把 runtime 预算种类带入 task.terminal', () => {
    const db = createDb(':memory:');
    db.exec(SCHEMA_SQL);
    const sessions = new SessionRepository(db);
    const toolCalls = new ToolCallRepository(db);
    const judge = new JudgeService({ db, toolCalls });
    const sid = sessions.create({ provider: 'openai', model: 'gpt-4o-mini' }).id;
    const run = judge.judge(sid, {
      finishReason: 'budget_exhausted',
      iteration: 3,
      tokenBudget: 256_000,
      budgetKind: 'wall_clock',
      budgetLimit: 180_000,
      budgetUsed: 471_721,
      usage: { promptTokens: 20_000, completionTokens: 1_000 },
      circuitOpened: false,
    });
    const terminal = run.verdicts.find((v) => v.criterion === 'task.terminal');
    expect(terminal?.detail).toContain('墙钟预算耗尽');
    expect(terminal?.detail?.includes('471721/180000')).toBe(true);
  });
});
