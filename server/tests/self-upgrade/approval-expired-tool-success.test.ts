/**
 * Judge · 审批过期不是工具执行失败。
 *
 * 线上 g3 的 0.923 来自一次 fs.write 审批过期：调用根本没执行，却被记成
 * `rejected` 并进入 tool.success_rate 分母。审批过期属于「未执行」，应由
 * approval.friction/审批状态承担责任，不能污染工具执行成功率。
 *
 * 本判据同时守住反面：用户明确拒绝仍是 rejected，仍计入分母；真实执行失败
 * 也不得被跳过。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ToolExecutor, type ExecuteItemInput, type ExecutorDeps } from '../../src/services/tools/executor.service.js';
import { toolSuccessRate, DEFAULT_L0_THRESHOLDS } from '../../src/services/judge/criteria.js';
import type { JudgeEvidence } from '../../src/services/judge/types.js';
import type { ToolCallRow } from '../../src/services/memory/tool-call.repository.js';
import type { ToolDefinition, RiskVerdict } from '../../src/types/tool.js';
import type { SseWriter } from '../../src/services/agent/sse-writer.js';

let sandboxRoot = '';
let recorded: { status: string; errorKind?: string | null } | null = null;

beforeEach(() => {
  sandboxRoot = mkdtempSync(path.join(tmpdir(), 'cl-approval-'));
  writeFileSync(path.join(sandboxRoot, 'impl.cjs'), 'old', 'utf8');
  recorded = null;
});
afterEach(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
});

const definition = (): ToolDefinition =>
  ({
    name: 'fs.write',
    wireName: 'fs_write',
    displayName: '写入文件',
    category: 'file',
    description: 'test write',
    inputSchema: { type: 'object' },
    handler: async () => {
      throw new Error('审批过期时 handler 绝不能执行');
    },
    timeoutMs: 1000,
    risk: 'high',
    approvalMode: 'hard',
    enabled: () => true,
    source: 'builtin',
    idempotent: false,
    maxResultChars: 1000,
  }) as unknown as ToolDefinition;

const callRow = (): ToolCallRow =>
  ({
    id: 'tc_approval',
    session_id: 'sess_approval',
    message_id: null,
    call_id: 'call_approval',
    tool_name: 'fs.write',
    tool_wire_name: 'fs_write',
    display_name: '写入文件',
    category: 'file',
    source: 'builtin',
    risk: 'high',
    approval_mode: 'hard',
    channel: 'native',
    iteration: 1,
    args_json: JSON.stringify({ path: 'impl.cjs', operation: 'overwrite', content: 'new' }),
    args_digest: 'digest',
    status: 'pending',
    error_kind: null,
    error_msg: null,
    result_ref: null,
    result_summary: null,
    truncated: 0,
    started_at: null,
    ended_at: null,
    duration_ms: 0,
    created_at: Date.now(),
  }) as ToolCallRow;

async function runDecision(decision: 'expired' | 'reject'): Promise<{ status: string; errorKind?: string | null }> {
  const verdict: RiskVerdict = { risk: 'high', approvalMode: 'hard' };
  const item: ExecuteItemInput = {
    toolCall: callRow(),
    definition: definition(),
    args: { path: 'impl.cjs', operation: 'overwrite', content: 'new' },
    digest: 'digest',
    verdict,
    channel: 'native',
    iteration: 1,
  };
  const deps = {
    toolCalls: {
      markFinished: (_id: string, fields: { status: string; errorKind?: string | null }) => {
        recorded = { status: fields.status, errorKind: fields.errorKind };
      },
    },
    toolResults: {},
    approvals: {
      hasSessionGrant: () => false,
      requestApproval: async () => decision,
    },
    sse: { emit: () => undefined } as unknown as SseWriter,
    sandboxRoot,
    allowedDirs: [],
    canRetry: () => false,
    onRetryConsumed: () => undefined,
  } as unknown as ExecutorDeps;
  const executor = new ToolExecutor(deps);
  const outcomes = await executor.executeBatch([item]);
  const outcome = outcomes.get('call_approval')!;
  return { status: outcome.status, errorKind: recorded?.errorKind };
}

const evidence = (statuses: string[]): JudgeEvidence => ({
  sessionId: 'sess_approval',
  finishReason: 'stop',
  iteration: 1,
  tokenBudget: 10_000,
  usage: { promptTokens: 10, completionTokens: 5 },
  toolCalls: statuses.map((status) => ({ status, display_name: '写入文件' })),
  approvals: [],
  circuitOpened: false,
});

describe('审批未执行不污染 tool.success_rate', () => {
  it('审批过期 → 落为 skipped，12 成功 + 1 过期仍是 100%', async () => {
    const out = await runDecision('expired');
    expect(out.status).toBe('skipped');
    expect(out.status === 'skipped').toBe(true);
    expect(recorded?.status === 'rejected').toBe(false);
    expect(out.errorKind).toBe('approval_expired');
    expect(recorded?.status).toBe('skipped');

    const rate = toolSuccessRate(evidence(['success', 'success', out.status]), DEFAULT_L0_THRESHOLDS);
    expect(rate.status).toBe('pass');
    expect(rate.score).toBe(1);
    expect(rate.score === 1).toBe(true);
  });

  it('用户明确拒绝 → 仍是 rejected，仍计入分母（不能被一起洗白）', async () => {
    const out = await runDecision('reject');
    expect(out.status).toBe('rejected');
    expect(out.status === 'rejected').toBe(true);
    expect(out.status === 'skipped').toBe(false);
    expect(recorded?.status).toBe('rejected');

    const rate = toolSuccessRate(evidence(['success', out.status]), DEFAULT_L0_THRESHOLDS);
    expect(rate.score).toBe(0.5);
    expect(rate.status).toBe('fail');
  });

  it('真实失败仍是被拒绝的近似反例：failed 不因本题改变口径', () => {
    const rate = toolSuccessRate(evidence(['success', 'failed']), DEFAULT_L0_THRESHOLDS);
    expect(rate.score).toBe(0.5);
    expect(rate.status).toBe('fail');
  });
});
