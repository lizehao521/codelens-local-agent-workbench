/**
 * E · 审批疲劳消解：
 *  1. 可逆写入第二次起不弹卡 + 一行提示 + 留痕（授权 id / 步骤）；
 *  2. 不可逆第二次仍必弹（红线）；
 *  3. 敏感路径第二次仍必弹（红线）；
 *  4. 越界目录不去重（红线）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolExecutor, type ExecuteItemInput } from '../src/services/tools/executor.service.js';
import { ApprovalDedupService } from '../src/services/agent/approval-dedup.service.js';
import type { ToolCallRow } from '../src/services/memory/tool-call.repository.js';
import type { ToolResultRow } from '../src/services/memory/tool-result.repository.js';
import type { ApprovalService } from '../src/services/agent/approval.service.js';
import type { SseWriter } from '../src/services/agent/sse-writer.js';
import type { EffectPreview, ToolDefinition, ToolOutcome, RiskVerdict } from '../src/types/tool.js';
import { argsDigest } from '../src/utils/digest.js';

let sandboxRoot: string;

beforeEach(() => {
  sandboxRoot = mkdtempSync(path.join(tmpdir(), 'codelens-dedup-'));
});

afterEach(() => {
  try {
    rmSync(sandboxRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function effect(reversible: boolean, file: string): EffectPreview {
  return {
    reversible,
    summary: reversible ? '写入文件（可撤销）' : '覆盖文件（不可撤销）',
    items: [{ path: path.join(sandboxRoot, file), kind: 'file', exists: false, bytes: 0 }],
    itemCount: 1,
    recoverable: reversible,
    recoveryNote: reversible ? '写前快照可撤销' : null,
  };
}

function definition(): ToolDefinition {
  return {
    name: 'fs.write',
    wireName: 'fs_write',
    displayName: '写入文件',
    category: 'file',
    description: 'test',
    inputSchema: { type: 'object' },
    handler: async (): Promise<ToolOutcome> => ({ ok: true, summary: 'ok', data: { ok: true } }),
    timeoutMs: 5000,
    risk: 'medium',
    approvalMode: 'hard',
    enabled: () => true,
    source: 'builtin',
    idempotent: true,
    maxResultChars: 100_000,
  };
}

function row(callId: string): ToolCallRow {
  return {
    id: `tc_${callId}`,
    session_id: 'sess',
    message_id: 'm',
    call_id: callId,
    tool_name: 'fs.write',
    tool_wire_name: 'fs_write',
    display_name: '写入文件',
    category: 'file',
    source: 'builtin',
    risk: 'medium',
    approval_mode: 'hard',
    channel: 'native',
    iteration: 1,
    args_json: '{"path":"a.txt"}',
    args_digest: argsDigest({ path: 'a.txt' }),
    status: 'pending',
    error_kind: null,
    error_msg: null,
    result_ref: null,
    result_summary: null,
    truncated: 0,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    created_at: Date.now(),
  } as unknown as ToolCallRow;
}

function makeExecutor(opts: {
  dedup: ApprovalDedupService;
  events: Array<{ name: string; data: any }>;
  approvals: { count: number };
  dedupTraces: Array<{ grantId: string; step: number }>;
}): { executor: ToolExecutor; rows: ToolCallRow[] } {
  const rows: ToolCallRow[] = [];
  const approvals = {
    hasSessionGrant: () => false,
    requestApproval: async (req: { onIssued?: (id: string) => void }) => {
      opts.approvals.count += 1;
      req.onIssued?.(`ap_${opts.approvals.count}`);
      return 'allow_once';
    },
  };
  const executor = new ToolExecutor({
    toolCalls: {
      insert: (r: ToolCallRow) => (rows.push(r), r),
      listBySession: () => rows,
      markRunning: () => undefined,
      markFinished: (id: string, patch: Partial<ToolCallRow>) => {
        const found = rows.find((r) => r.id === id);
        if (found) Object.assign(found, patch);
      },
    } as never,
    toolResults: {
      insert: (f: Partial<ToolResultRow>) => ({ id: 'tr', created_at: Date.now(), ...f }) as ToolResultRow,
    } as never,
    approvals: approvals as unknown as ApprovalService,
    sse: { emit: (name: string, data: unknown) => opts.events.push({ name, data }) } as unknown as SseWriter,
    sandboxRoot,
    allowedDirs: [],
    canRetry: () => false,
    onRetryConsumed: () => undefined,
    runId: 'run_1',
    dedup: opts.dedup,
    onApprovalDedup: ({ reusedGrantId, reusedStep }) =>
      opts.dedupTraces.push({ grantId: reusedGrantId, step: reusedStep }),
  });
  return { executor, rows };
}

async function runOnce(
  executor: ToolExecutor,
  rows: ToolCallRow[],
  callId: string,
  eff: EffectPreview,
  verdictMode: 'hard' | 'soft' = 'hard',
) {
  const toolCall = row(callId);
  rows.push(toolCall);
  const verdict: RiskVerdict = { risk: 'medium', approvalMode: verdictMode, effect: eff };
  const outcomes = await executor.executeBatch([
    {
      toolCall,
      definition: definition(),
      args: { path: 'a.txt' },
      digest: argsDigest({ path: 'a.txt' }),
      verdict,
      channel: 'native',
      iteration: 1,
    } as ExecuteItemInput,
  ]);
  return outcomes.get(callId);
}

describe('E · 审批去重', () => {
  it('可逆写入第二次起不弹卡，发一行提示并留痕', async () => {
    const dedup = new ApprovalDedupService();
    const events: Array<{ name: string; data: any }> = [];
    const approvals = { count: 0 };
    const traces: Array<{ grantId: string; step: number }> = [];
    const { executor, rows } = makeExecutor({ dedup, events, approvals, dedupTraces: traces });
    const eff = effect(true, 'a.txt');

    const first = await runOnce(executor, rows, 'c1', eff);
    const second = await runOnce(executor, rows, 'c2', eff);

    expect(first?.status).toBe('success');
    expect(second?.status).toBe('success');
    // 只弹了 1 次审批
    expect(approvals.count).toBe(1);
    // 第二次有一行提示事件
    const dedupEvent = events.find((e) => e.name === 'approval_dedup');
    expect(dedupEvent).toBeTruthy();
    expect(dedupEvent!.data.text).toBe('已按你上次的授权执行，可撤销');
    expect(dedupEvent!.data.reusedGrantId).toBe('ap_1');
    // RunState 留痕拿到原始授权 id 与步骤
    expect(traces).toEqual([{ grantId: 'ap_1', step: 1 }]);
  });

  it('红线：不可逆操作第二次仍必弹', async () => {
    const dedup = new ApprovalDedupService();
    const events: Array<{ name: string; data: any }> = [];
    const approvals = { count: 0 };
    const { executor, rows } = makeExecutor({ dedup, events, approvals, dedupTraces: [] });
    const eff = effect(false, 'a.txt');

    await runOnce(executor, rows, 'c1', eff);
    await runOnce(executor, rows, 'c2', eff);

    expect(approvals.count).toBe(2);
    expect(events.some((e) => e.name === 'approval_dedup')).toBe(false);
  });

  it('红线：敏感路径（.env）第二次仍必弹', async () => {
    const dedup = new ApprovalDedupService();
    const events: Array<{ name: string; data: any }> = [];
    const approvals = { count: 0 };
    const { executor, rows } = makeExecutor({ dedup, events, approvals, dedupTraces: [] });
    const eff = effect(true, '.env');

    await runOnce(executor, rows, 'c1', eff);
    await runOnce(executor, rows, 'c2', eff);

    expect(approvals.count).toBe(2);
    expect(events.some((e) => e.name === 'approval_dedup')).toBe(false);
  });

  it('红线：越界目录不去重（keyFor 直接拒绝）', () => {
    const dedup = new ApprovalDedupService();
    const outside: EffectPreview = {
      reversible: true,
      summary: '写入工作区外',
      items: [{ path: path.join(tmpdir(), 'outside-dedup', 'x.txt'), kind: 'file', exists: false, bytes: 0 }],
      itemCount: 1,
      recoverable: true,
      recoveryNote: null,
    };
    expect(
      dedup.keyFor({
        runId: 'run_1',
        toolName: 'fs.write',
        effect: outside,
        sandboxRoot,
        allowedDirs: [],
      }),
    ).toBeNull();
  });
});
