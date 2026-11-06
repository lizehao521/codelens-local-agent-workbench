/**
 * 判据塔 → Update → π 的闭环测试。
 *
 * 验证的是宣言第 1 节那条链真的接通：
 *   Judge 产 r → Update 消费 r 生 π' → 下一轮 Act 可读 → 有效性可被聚合
 *
 * 与旧实现的差别必须在测试里被钉死：
 *  - 旧版只要「有工具失败」就写同一条模板；
 *  - 新版经验由**具体 fail 判据**决定，pass / inconclusive 不产生任何噪声。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { SessionRepository } from '../src/services/memory/session.repository.js';
import { ToolCallRepository } from '../src/services/memory/tool-call.repository.js';
import { JudgeService } from '../src/services/judge/judge.service.js';
import { UpdateService } from '../src/services/agent/update.service.js';
import { buildSystemPrompt } from '../src/services/agent/system-prompt.js';
import type { JudgeRunResult } from '../src/services/judge/types.js';

let db: Db;
let sessions: SessionRepository;
let toolCalls: ToolCallRepository;
let judge: JudgeService;
let policy: UpdateService;

beforeEach(() => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  sessions = new SessionRepository(db);
  toolCalls = new ToolCallRepository(db);
  judge = new JudgeService({ db, toolCalls });
  policy = new UpdateService(db, judge.repository);
  judge.setThresholdsProvider(() => policy.getPolicy().thresholds);
});

function newSession(): string {
  return sessions.create({ provider: 'deepseek', model: 'deepseek-chat' }).id;
}

let seq = 0;
function addToolCall(sessionId: string, status: 'success' | 'failed') {
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
}

const baseRuntime = {
  finishReason: 'stop',
  iteration: 3,
  tokenBudget: 100_000,
  usage: { promptTokens: 20_000, completionTokens: 5_000 },
  circuitOpened: false,
};

describe('r → π\'：只有 fail 判据才产生经验', () => {
  it('工具失败导致 fail → 沉淀「工具成功率」对应的经验', () => {
    const sid = newSession();
    addToolCall(sid, 'failed');
    addToolCall(sid, 'failed');

    const run = judge.judge(sid, { ...baseRuntime, finishReason: 'max_iterations' });
    expect(run.verdict).toBe('fail');

    const next = policy.applyFromJudge(run, run.runId!);
    expect(next).not.toBeNull();
    expect(next!.lessons.some((l) => l.includes('工具调用成功率偏低'))).toBe(true);
  });

  it('不同失败模式得到不同经验，而不是一句万能模板', () => {
    const sid = newSession();
    addToolCall(sid, 'failed');
    const a = judge.judge(sid, { ...baseRuntime, finishReason: 'max_iterations' });
    const lessonsA = policy.lessonsFor(a);

    const sid2 = newSession();
    addToolCall(sid2, 'success');
    const b = judge.judge(sid2, { ...baseRuntime, circuitOpened: true, finishReason: 'circuit_open' });
    const lessonsB = policy.lessonsFor(b);

    expect(lessonsA.length).toBeGreaterThan(0);
    expect(lessonsB.length).toBeGreaterThan(0);
    expect(lessonsA).not.toEqual(lessonsB);
  });

  it('pass 判决不产生新版本（不制造噪声）', () => {
    const sid = newSession();
    addToolCall(sid, 'success');
    const run = judge.judge(sid, baseRuntime);
    expect(run.verdict).toBe('pass');

    const before = policy.currentVersion();
    const next = policy.applyFromJudge(run, run.runId!);
    expect(next).toBeNull();
    expect(policy.currentVersion()).toBe(before);
  });

  it('inconclusive 不产生新版本（不知道错在哪就不该乱学）', () => {
    const sid = newSession();
    const run = judge.judge(sid, {
      finishReason: 'stop',
      iteration: 1,
      tokenBudget: 0,
      usage: { promptTokens: 0, completionTokens: 0 },
      circuitOpened: false,
    });
    expect(run.verdict).toBe('inconclusive');
    expect(policy.applyFromJudge(run, run.runId!)).toBeNull();
  });

  it('新经验能被下一轮 Act 读到（buildSystemPrompt 消费者）', () => {
    const sid = newSession();
    addToolCall(sid, 'failed');
    const run = judge.judge(sid, { ...baseRuntime, finishReason: 'max_iterations' });
    policy.applyFromJudge(run, run.runId!);

    const prompt = buildSystemPrompt(undefined, policy.getPolicy());
    expect(prompt).toContain('来自过往经验的策略');
    expect(prompt).toContain('工具调用成功率偏低');
  });
});

describe('判决可追溯：source_judgment 指回 judge run', () => {
  it('版本记录的来源能定位到具体 run id 与失败判据', () => {
    const sid = newSession();
    addToolCall(sid, 'failed');
    const run = judge.judge(sid, { ...baseRuntime, finishReason: 'max_iterations' });
    policy.applyFromJudge(run, run.runId!);

    const latest = policy.listVersions().at(-1)!;
    expect(latest.sourceJudgment).toContain(`judge:run:${run.runId}`);
    expect(latest.sourceJudgment).toContain('tool.success_rate');
  });
});

describe('注入记账与经验有效性聚合', () => {
  it('记录的注入能被 lessonEffectiveness 关联到判决结果', () => {
    const sid = newSession();
    addToolCall(sid, 'success');
    const run = judge.judge(sid, baseRuntime);

    judge.recordInjections(sid, 1, ['经验甲']);
    const rows = judge.effectiveness();
    const row = rows.find((r) => r.lesson === '经验甲');

    expect(row).toBeDefined();
    expect(row!.injected).toBe(1);
    expect(row!.passes).toBe(1);
    expect(row!.passRate).toBe(1);
    expect(run.verdict).toBe('pass');
  });

  it('同一会话重复注入同一经验只记一次（不放大统计）', () => {
    const sid = newSession();
    addToolCall(sid, 'success');
    judge.judge(sid, baseRuntime);

    judge.recordInjections(sid, 1, ['经验甲']);
    judge.recordInjections(sid, 1, ['经验甲']);
    judge.recordInjections(sid, 1, ['经验甲']);

    const row = judge.effectiveness().find((r) => r.lesson === '经验甲');
    expect(row!.injected).toBe(1);
  });

  it('没有判决结果的注入记为 pending，不假装通过', () => {
    const sid = newSession();
    judge.recordInjections(sid, 1, ['未验证经验']);

    const row = judge.effectiveness().find((r) => r.lesson === '未验证经验');
    expect(row!.injected).toBe(1);
    expect(row!.pending).toBe(1);
    expect(row!.passRate).toBeNull();
  });
});

describe('π 淘汰策略：按有效性而非新旧', () => {
  it('超限时优先淘汰「注入后通过率为 0」的经验，保留高通过率的', () => {
    // 铺满 50 条，其中 lesson-0 有失败记录、lesson-49 有通过记录，其余无数据。
    const initial = Array.from({ length: 50 }, (_, i) => `lesson-${i}`);
    policy.applyUpdate({ addLessons: initial });

    const failSession = newSession();
    addToolCall(failSession, 'failed');
    judge.judge(failSession, { ...baseRuntime, finishReason: 'max_iterations' });
    judge.recordInjections(failSession, policy.currentVersion(), ['lesson-0']);

    const passSession = newSession();
    addToolCall(passSession, 'success');
    judge.judge(passSession, baseRuntime);
    judge.recordInjections(passSession, policy.currentVersion(), ['lesson-49']);

    // 再加一条，触发 1 条淘汰
    policy.applyUpdate({ addLessons: ['lesson-new'] });
    const lessons = policy.getPolicy().lessons;

    expect(lessons).toHaveLength(50);
    expect(lessons).not.toContain('lesson-0'); // 最低效者出局
    expect(lessons).toContain('lesson-49'); // 有效者保留
    expect(lessons).toContain('lesson-new');
  });

  it('无有效性数据时退化为丢弃最旧（保持历史行为，不误伤）', () => {
    const noJudge = new UpdateService(db);
    noJudge.applyUpdate({ addLessons: Array.from({ length: 51 }, (_, i) => `x-${i}`) });
    const lessons = noJudge.getPolicy().lessons;
    expect(lessons).toHaveLength(50);
    expect(lessons).not.toContain('x-0');
    expect(lessons).toContain('x-50');
  });
});

describe('端到端：一次完整闭环', () => {
  it('失败任务 → 判决 fail → 经验入库 → 下次注入 → 有效性可查', () => {
    // 1) 第一次任务：工具失败，迭代耗尽
    const first = newSession();
    addToolCall(first, 'failed');
    const run = judge.judge(first, { ...baseRuntime, finishReason: 'max_iterations' });
    expect(run.verdict).toBe('fail');

    // 2) Update 消费判决
    const applied = policy.applyFromJudge(run, run.runId!);
    expect(applied!.lessons.length).toBeGreaterThan(0);

    // 3) 第二次任务：Act 注入该经验
    const second = newSession();
    judge.recordInjections(second, policy.currentVersion(), applied!.lessons);
    addToolCall(second, 'success');
    const run2 = judge.judge(second, baseRuntime);
    expect(run2.verdict).toBe('pass');

    // 4) 经验有效性可聚合
    const rows = judge.effectiveness();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.passRate === null || typeof r.passRate === 'number')).toBe(true);

    // 5) 判决历史可复盘
    expect(judge.repository.listRuns({ limit: 10 }).length).toBe(2);
  });
});
