/**
 * 分层覆盖率（判据塔 v2 缺陷 A / D 的回归夹具）。
 *
 * 这一组测试的唯一使命：把「覆盖率分母」这件事钉死。
 * 缺陷 A 的本质是分母被层内判据数量稀释 —— L0 有 5 条几乎总能跑，
 * L2/L3 恒不跑却各占一个名额，于是 5/8=0.625 越过了 0.6 的门槛，
 * 「判据塔只跑了一半」被算成「测得差不多了」。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { SessionRepository } from '../src/services/memory/session.repository.js';
import { ToolCallRepository } from '../src/services/memory/tool-call.repository.js';
import { JudgeService } from '../src/services/judge/judge.service.js';
import { summarize } from '../src/services/judge/summarize.js';
import { UpdateService } from '../src/services/agent/update.service.js';
import type { SemanticAssessor } from '../src/services/judge/semantic.js';
import {
  COVERAGE_THRESHOLD,
  DEFAULT_LAYER_PROFILES,
  type CriterionVerdict,
  type LayerProfile,
} from '../src/services/judge/types.js';

let db: Db;
let sessions: SessionRepository;
let toolCalls: ToolCallRepository;

beforeEach(() => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  sessions = new SessionRepository(db);
  toolCalls = new ToolCallRepository(db);
});

function newJudge(semantic?: SemanticAssessor): JudgeService {
  return new JudgeService({ db, toolCalls, ...(semantic ? { semantic } : {}) });
}

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

/** 无审批 + 1 次成功工具 + 预算充足：L0 里唯一跑不了的是 approval.friction。 */
function seedCleanRun(sessionId: string): void {
  addToolCall(sessionId, 'success');
}

const cleanRuntime = {
  finishReason: 'stop',
  iteration: 3,
  tokenBudget: 100_000,
  usage: { promptTokens: 20_000, completionTokens: 5_000 },
  circuitOpened: false,
};

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

describe('A1/A2：分母只算 available 层', () => {
  it('A1 无审批 + 1 次成功工具 + 预算充足 → coverage 0.833 / tower 0.625 / degraded / pass', () => {
    const judge = newJudge(); // 不注入语义评估器 → L2 不可用
    const sid = newSession();
    seedCleanRun(sid);

    const run = judge.judge(sid, cleanRuntime);

    // 主口径：L0 5 条 + L1 1 条 = 6，执行 5 条（approval.friction 无审批）
    expect(run.total).toBe(6);
    expect(run.executed).toBe(5);
    expect(run.coverage).toBe(0.833);
    // 全塔口径只用于展示：8 条判据里执行了 5 条
    expect(run.towerTotal).toBe(8);
    expect(run.towerExecuted).toBe(5);
    expect(run.towerCoverage).toBe(0.625);

    expect(run.degraded).toBe(true);
    expect(run.unavailableLayers.map((p) => p.layer)).toEqual(['L2', 'L3']);
    expect(run.verdict).toBe('pass');
    expect(run.layerCoverage.L0).toBe(0.8);
    expect(run.layerCoverage.L1).toBe(1);
    // 不可用层是 null（未知），不是 0（全红）
    expect(run.layerCoverage.L2).toBeNull();
    expect(run.layerCoverage.L3).toBeNull();
  });

  it('A2 主口径 coverage 不得等于全塔口径（谁把分母改回去就立刻红）', () => {
    const judge = newJudge();
    const sid = newSession();
    seedCleanRun(sid);

    const run = judge.judge(sid, cleanRuntime);

    expect(run.coverage).toBeGreaterThanOrEqual(COVERAGE_THRESHOLD);
    // 全塔口径 0.625 也过 0.6 —— 但它不该被当作定档依据
    expect(run.coverage).not.toBe(round3(run.towerExecuted / run.towerTotal));
    expect(run.coverage).toBe(round3(run.executed / run.total));
  });
});

describe('A3：必需层不可用 ⇒ fail-closed', () => {
  it('L2 被声明为 required 但 available=false ⇒ inconclusive + required_layer_unexecuted', () => {
    const judge = newJudge();
    const sid = newSession();
    seedCleanRun(sid);
    const run = judge.judge(sid, cleanRuntime);

    // profile 配错（required 却没接线）必须挡在 pass 之外
    const profiles: LayerProfile[] = DEFAULT_LAYER_PROFILES.map((p) =>
      p.layer === 'L2' ? { layer: 'L2' as const, available: false, required: true, reason: 'assessor_not_wired' as const } : p,
    );
    const s = summarize(run.verdicts, profiles);

    expect(s.verdict).toBe('inconclusive');
    expect(s.reasons).toContain('required_layer_unexecuted');
    expect(s.requiredGaps).toContainEqual({ layer: 'L2', reason: 'unavailable' });
  });
});

describe('A4：判据塔自身故障不等于任务失败（缺陷 D）', () => {
  const alwaysPass: SemanticAssessor = {
    id: 'fake.always-pass',
    kind: 'rules',
    assess: () => ({ layer: 'L2', criterion: 'semantic.task_completion', status: 'pass', detail: '永真闸' }),
  };

  it('永真语义评估器 → L1 fail → inconclusive + judge_self_check_failed，且不产生 π 新版本', () => {
    const judge = newJudge(alwaysPass);
    const policy = new UpdateService(db, judge.repository);
    judge.setThresholdsProvider(() => policy.getPolicy().thresholds);

    const sid = newSession();
    seedCleanRun(sid);
    const before = policy.currentVersion();

    const run = judge.judge(sid, cleanRuntime);

    // L1 抓到了永真闸
    expect(run.verdicts.find((v) => v.layer === 'L1')?.status).toBe('fail');
    // 自证故障 → inconclusive，绝不能被写成「任务失败」
    expect(run.verdict).toBe('inconclusive');
    expect(run.reasons).toContain('judge_self_check_failed');
    expect(run.verdict).not.toBe('fail');

    // 不得产生 π 新版本：自证故障不该教出任何经验
    expect(policy.applyFromJudge(run, run.runId!)).toBeNull();
    expect(policy.currentVersion()).toBe(before);
  });
});

describe('A5：金丝雀未执行 ⇒ L0 全 unexec，且不能误报自证故障', () => {
  it('5 条 L0 unexec + L1 unexec → layerCoverage.L0=0、required_layer_unexecuted、inconclusive', () => {
    const verdicts: CriterionVerdict[] = [
      ...['tool.success_rate', 'task.terminal', 'loop.health', 'approval.friction', 'budget.efficiency'].map(
        (criterion): CriterionVerdict => ({ layer: 'L0', criterion, status: 'unexec', detail: '金丝雀不可用' }),
      ),
      { layer: 'L1', criterion: 'canary.discrimination', status: 'unexec', detail: '样本不足' },
      { layer: 'L2', criterion: 'semantic.task_completion', status: 'unexec' },
      { layer: 'L3', criterion: 'adversarial.deception_resistance', status: 'unexec' },
    ];

    const s = summarize(verdicts);

    expect(s.layerCoverage.L0).toBe(0);
    expect(s.verdict).toBe('inconclusive');
    expect(s.reasons).toContain('required_layer_unexecuted');
    // L1 是 unexec 而不是 fail：这不是「自证故障」，只是「没验证」
    expect(s.reasons).not.toContain('judge_self_check_failed');
    expect(s.requiredGaps).toContainEqual({ layer: 'L0', reason: 'unexecuted' });
  });

  it('judge() 在金丝雀不通过时把 5 条 L0 全部降为 unexec', () => {
    const alwaysPass: SemanticAssessor = {
      id: 'fake.always-pass-2',
      kind: 'rules',
      assess: () => ({ layer: 'L2', criterion: 'semantic.task_completion', status: 'pass' }),
    };
    const judge = newJudge(alwaysPass);
    const sid = newSession();
    seedCleanRun(sid);
    const run = judge.judge(sid, cleanRuntime);

    const l0 = run.verdicts.filter((v) => v.layer === 'L0');
    expect(l0).toHaveLength(5);
    expect(l0.every((v) => v.status === 'unexec')).toBe(true);
  });
});

describe('A16：旧单参调用仍可用（向后兼容）', () => {
  it('summarize(verdicts) 不带 profiles 也能跑，并返回全部新字段', () => {
    const verdicts: CriterionVerdict[] = [
      { layer: 'L0', criterion: 'a', status: 'pass' },
      { layer: 'L1', criterion: 'canary.discrimination', status: 'pass' },
    ];
    const s = summarize(verdicts);

    expect(s.verdict).toBe('pass');
    expect(s.coverage).toBe(1);
    expect(s.towerCoverage).toBe(1);
    // degraded = 「本次有可执行判据未执行」，全绿时为 false
    expect(s.degraded).toBe(false);
    expect(s.reasons).toEqual([]);
    expect(s.layerCoverage.L2).toBeNull();
    expect(Array.isArray(s.requiredGaps)).toBe(true);
  });

  it('degraded 表达「本次判决被削弱」，不再因 L3 永不可用而恒真', () => {
    const withUnexec = summarize([
      { layer: 'L0', criterion: 'a', status: 'pass' },
      { layer: 'L0', criterion: 'b', status: 'unexec' },
      { layer: 'L1', criterion: 'canary.discrimination', status: 'pass' },
    ]);
    expect(withUnexec.degraded).toBe(true);
  });
});

describe('weightExcluded：不适用 ≠ 通过 1.0', () => {
  // L2 默认未接线（available=false），要验证 L2 的权重语义必须显式声明它可用。
  const profiles: LayerProfile[] = DEFAULT_LAYER_PROFILES.map((p) =>
    p.layer === 'L2' ? { layer: 'L2' as const, available: true, required: false, reason: null } : p,
  );

  it('S7「不适用」的 pass 不进 score 均值，但仍算已执行', () => {
    const base: CriterionVerdict[] = [
      { layer: 'L0', criterion: 'a', status: 'pass' },
      { layer: 'L0', criterion: 'b', status: 'fail' },
      { layer: 'L1', criterion: 'canary.discrimination', status: 'pass' },
    ];
    const withS7: CriterionVerdict[] = [
      ...base,
      { layer: 'L2', criterion: 'semantic.task_completion', status: 'pass', weightExcluded: true },
    ];

    const without = summarize(base, profiles);
    const explanatory = summarize(withS7, profiles);

    // S7 没被当成 1.0：两者分数一致
    expect(explanatory.score).toBe(without.score);
    // 但它确实产出了结论，因此仍计入覆盖率分母（executed +1、total +1）
    expect(explanatory.total).toBe(without.total + 1);
    expect(explanatory.executed).toBe(without.executed + 1);
  });
});
