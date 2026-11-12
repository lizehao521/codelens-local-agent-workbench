/**
 * RunState + 汇报卡自证（三场景）：
 *  1. 纯问答：无工具/无改动 → 不出卡（hasMaterialChange=false）；
 *  2. 只读极简：有工具调用但无实质变化 → 不出卡；
 *  3. 写 + 审批 + 不可逆：完整卡，数字与 RunState 逐项交叉核对；
 * 另外锁定：可持久化、可按 runId 查、不含凭证；everyRun=true 时每轮必报。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { RunStateService } from '../src/services/agent/run-state.service.js';
import type { RunToolRecord } from '../src/types/run-state.js';

let db: Db;

function start(svc: RunStateService, runId: string): void {
  svc.start({ runId, sessionId: 'se_1', provider: 'nvidia', model: 'm', channel: 'native' });
}

function tool(overrides: Partial<RunToolRecord> = {}): RunToolRecord {
  return {
    callId: 'call_1',
    name: 'fs.read',
    iteration: 1,
    status: 'success',
    startedAt: Date.now(),
    durationMs: 10,
    risk: 'low',
    approvalMode: 'none',
    effectReversible: true,
    resultSummary: 'ok',
    errorCode: null,
    ...overrides,
  };
}

beforeEach(() => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

describe('RunState + 汇报卡', () => {
  it('context_full：汇报卡给出可读原因与建议，状态码仍与完成区分', () => {
    const svc = new RunStateService(db);
    start(svc, 'run_ctx');
    svc.stage('run_ctx', 'connecting');
    const detail =
      '上下文已满：压缩自检未通过（缺：用户约束），任务已回退。建议：新建会话，或把任务拆小后重试';
    const report = svc.finish('run_ctx', 'error', 'context_full', { promptTokens: 1200, completionTokens: 80 }, detail);

    expect(report).not.toBeNull();
    // 金丝雀：修复前 reason 为 null；这条断言会红。
    expect(report!.reason).toBe(detail);
    expect(report!.outcome).toBe('error');
    expect(report!.statusCode).toBe('RUN_ERROR');
    expect(report!.statusCode).not.toBe('RUN_COMPLETED');
    expect(report!.finishReason).toBe('context_full');
    expect(report!.reason).toContain('建议');
    // #8-④：不再与 reason 里的「上下文已满…安全回退」并列出现「异常终止」；
    // 但 triggers 必须非空，否则 hasMaterialChange=false 会让整张卡消失。
    expect(report!.triggers).toContain('上下文已满');
    expect(report!.triggers).not.toContain('异常终止');
    expect(report!.hasMaterialChange).toBe(true);
  });

  it('#8-④ 对照：非 context_full 的 error 仍保留「异常终止」标签', () => {
    const svc = new RunStateService(db);
    start(svc, 'run_err');
    svc.stage('run_err', 'connecting');
    const report = svc.finish('run_err', 'error', 'error', { promptTokens: 100, completionTokens: 20 });
    expect(report!.triggers).toContain('异常终止');
    expect(report!.triggers).not.toContain('上下文已满');
  });

  it('场景 1 纯问答：无实质变化 → 不出卡', () => {
    const svc = new RunStateService(db);
    start(svc, 'run_qa');
    svc.stage('run_qa', 'connecting');
    svc.stage('run_qa', 'content', '回答 42');
    const report = svc.finish('run_qa', 'ok', 'stop', { promptTokens: 120, completionTokens: 30 });
    expect(report).not.toBeNull();
    expect(report!.hasMaterialChange).toBe(false);
    expect(report!.triggers).toEqual([]);
    expect(report!.toolCallCount).toBe(0);
    expect(report!.fileChangeCount).toBe(0);
  });

  it('场景 2 只读极简：有工具调用但无实质变化 → 不出卡', () => {
    const svc = new RunStateService(db);
    start(svc, 'run_read');
    svc.tool('run_read', tool({ name: 'fs.list', effectReversible: true }));
    const report = svc.finish('run_read', 'ok', 'stop', { promptTokens: 300, completionTokens: 40 });
    expect(report!.hasMaterialChange).toBe(false);
    expect(report!.triggers).toEqual([]);
    expect(report!.toolCallCount).toBe(1);
  });

  it('场景 3 写 + 审批 + 不可逆：完整卡，数字与状态逐项一致', () => {
    const svc = new RunStateService(db);
    start(svc, 'run_full');
    svc.stage('run_full', 'tool_call');
    svc.tool('run_full', tool({ callId: 'call_w', name: 'fs.write', risk: 'high', approvalMode: 'hard', effectReversible: false }));
    svc.approval('run_full', { callId: 'call_w', name: 'fs.write', approvalMode: 'hard', decision: 'allow_once', at: Date.now() });
    svc.fileChange('run_full', {
      path: 'a.txt',
      step: 1,
      checkpointId: 'ck_1',
      beforeSha256: 'a'.repeat(64),
      afterSha256: 'b'.repeat(64),
      added: 1,
      removed: 1,
    });
    svc.error('run_full', { code: 'UPSTREAM_TIMEOUT', kind: 'degraded', message: '重试一次后成功', at: Date.now() });
    svc.cost('run_full', { reviewPromptTokens: 11, reviewCompletionTokens: 7 });
    const report = svc.finish('run_full', 'ok', 'stop', { promptTokens: 2000, completionTokens: 500 });

    expect(report!.hasMaterialChange).toBe(true);
    expect(report!.triggers).toEqual(['文件改动', '不可逆操作', '审批', '错误/降级']);
    expect(report!.fileChangeCount).toBe(1);
    expect(report!.irreversibleCount).toBe(1);
    expect(report!.approvalCount).toBe(1);
    expect(report!.errorCount).toBe(1);
    expect(report!.toolCallCount).toBe(1);
    expect(report!.promptTokens).toBe(2000);
    expect(report!.completionTokens).toBe(500);
    expect(report!.summary).toContain('改动 1 个文件');
    expect(report!.summary).toContain('不可逆操作 1 次');
    expect(report!.summary).toContain('token 2518（复核 18）');

    // 持久化 + 按 runId 可查；状态里的数字和报告同源。
    const state = svc.get('run_full');
    expect(state).not.toBeNull();
    expect(state!.fileChanges).toHaveLength(1);
    expect(state!.approvals).toHaveLength(1);
    expect(state!.tools[0].effectReversible).toBe(false);
    expect(svc.getReport('run_full')).toEqual(report);
  });

  it('everyRun=true：没有实质变化也强制出卡', () => {
    const svc = new RunStateService(db, { everyRun: true });
    start(svc, 'run_forced');
    const report = svc.finish('run_forced', 'ok', 'stop', { promptTokens: 10, completionTokens: 2 });
    expect(report!.hasMaterialChange).toBe(true);
  });

  it('不含凭证：state_json 不出现 key / baseUrl / Authorization', () => {
    const svc = new RunStateService(db);
    start(svc, 'run_clean');
    svc.finish('run_clean', 'ok', 'stop', { promptTokens: 1, completionTokens: 1 });
    const row = db.get<{ state_json: string }>('SELECT state_json FROM agent_runs WHERE run_id = ?', ['run_clean']);
    expect(row?.state_json).not.toContain('sk-');
    expect(row?.state_json).not.toContain('apiKey');
    expect(row?.state_json).not.toContain('Authorization');
    expect(row?.state_json).not.toContain('baseUrl');
  });

  it('A · 预算触顶：终态与完成态不同码，cutoff / reason / notDone 完整', () => {
    const svc = new RunStateService(db);
    start(svc, 'run_budget');
    svc.stage('run_budget', 'tool_call');
    svc.tool('run_budget', tool({ callId: 'c1', iteration: 3 }));
    svc.fileChange('run_budget', {
      path: 'a.txt',
      step: 3,
      checkpointId: 'ck',
      beforeSha256: 'a'.repeat(64),
      afterSha256: 'b'.repeat(64),
      added: 1,
      removed: 0,
    });
    svc.budget('run_budget', { kind: 'tool_calls', limit: 40, used: 40, atStep: 3, triggeredAt: Date.now() });

    expect(() =>
      svc.finish('run_budget', 'ok', 'budget_exhausted', { promptTokens: 100, completionTokens: 20 }),
    ).not.toThrow();
    const report = svc.getReport('run_budget');
    expect(report).not.toBeNull();
    expect(report!.outcome).toBe('budget_exhausted');
    expect(report!.statusCode).toBe('RUN_BUDGET_TOOL_CALLS');
    expect(report!.statusCode).not.toBe('RUN_COMPLETED');
    expect(report!.reason).toContain('工具调用预算');
    expect(report!.reason).toContain('第 3 步');
    expect(report!.reason).toContain('已完成 1 次工具调用');
    expect(report!.notDone).toContain('后续计划的工具调用未执行');
    expect(report!.triggers).toContain('预算耗尽');

    // 终态字段从 RunState 自身读，不另起统计。
    const state = svc.get('run_budget');
    expect(state!.budget).toMatchObject({ kind: 'tool_calls', atStep: 3 });
    expect(state!.cutoff).toMatchObject({ lastStage: 'tool_call', completedToolCalls: 1, completedFileChanges: 1 });
    expect(state!.cutoff!.unfinished).toEqual(['后续计划的工具调用未执行']);
  });

  it('A · 破坏夹具：未到顶（无 budget 记录）不得产出预算终态', () => {
    const svc = new RunStateService(db);
    start(svc, 'run_under');
    svc.finish('run_under', 'ok', 'stop', { promptTokens: 10, completionTokens: 2 });
    const report = svc.getReport('run_under');
    expect(report!.outcome).toBe('completed');
    expect(report!.statusCode).toBe('RUN_COMPLETED');
    expect(report!.notDone).toEqual([]);
    expect(report!.reason).toBeNull();
  });

  it('B · 收敛判定：outcome / statusCode 与完成态分开', () => {
    const svc = new RunStateService(db);
    start(svc, 'run_converged');
    svc.finish('run_converged', 'ok', 'converged', { promptTokens: 10, completionTokens: 2 });
    const report = svc.getReport('run_converged');
    expect(report!.outcome).toBe('converged');
    expect(report!.statusCode).toBe('RUN_CONVERGED');
    expect(report!.triggers).toContain('收敛判定');
  });

  it('list 按 session 可查（带 summary）', () => {
    const svc = new RunStateService(db);
    start(svc, 'run_l1');
    svc.fileChange('run_l1', { path: 'x', step: 1, checkpointId: null, beforeSha256: null, afterSha256: null, added: 1, removed: 0 });
    svc.finish('run_l1', 'ok', 'stop', { promptTokens: 1, completionTokens: 1 });
    const runs = svc.list('se_1');
    expect(runs[0]).toMatchObject({ runId: 'run_l1', status: 'ok' });
    expect(runs[0].summary).toContain('改动 1 个文件');
  });
});
