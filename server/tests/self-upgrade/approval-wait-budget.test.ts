/**
 * 判据 · 审批等待不得越过任务 wall-clock 预算。
 *
 * 现场：任务 wall-clock 180s 已耗尽，fs.write 仍 parked 等到审批 300s TTL，
 * 最后过期；tool.success_rate 被污染。审批等待必须由任务的绝对 deadline
 * 截断，而不是只看审批自己的 5 分钟 TTL。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ApprovalService } from '../../src/services/agent/approval.service.js';
import type { ApprovalRepository, ApprovalRow, InsertApprovalInput } from '../../src/services/memory/approval.repository.js';
import type { ToolCallRepository, ToolCallRow } from '../../src/services/memory/tool-call.repository.js';
import type { ToolRegistry } from '../../src/services/tools/registry.service.js';
import type { SseWriter } from '../../src/services/agent/sse-writer.js';
import { argsDigest } from '../../src/utils/digest.js';

const ARGS = { path: 'notes/a.txt', operation: 'create', content: 'x' };
const digest = argsDigest(ARGS);

class FakeApprovals {
  readonly rows = new Map<string, ApprovalRow>();
  private seq = 0;
  insert(input: InsertApprovalInput): ApprovalRow {
    const row: ApprovalRow = {
      id: `ap_${(this.seq += 1)}`, session_id: input.sessionId, tool_call_id: input.toolCallId,
      tool_name: input.toolName, args_digest: input.argsDigest, challenge_token_hash: input.challengeTokenHash,
      status: 'pending', decision: null, reason: null, mismatch_count: 0, last_mismatch_at: null,
      last_mismatch_detail: null, revised_from_id: input.revisedFromId ?? null, revise_depth: input.reviseDepth ?? 0,
      expires_at: input.expiresAt, decided_at: null, created_at: Date.now(),
    };
    this.rows.set(row.id, row);
    return row;
  }
  get(id: string): ApprovalRow | undefined { return this.rows.get(id); }
  markExpired(id: string): void { const row = this.rows.get(id); if (row?.status === 'pending') row.status = 'expired'; }
  markAborted(id: string): void { const row = this.rows.get(id); if (row?.status === 'pending') row.status = 'aborted'; }
  reissue(id: string, tokenHash: string, expiresAt: number): void {
    const row = this.rows.get(id);
    if (row) { row.challenge_token_hash = tokenHash; row.expires_at = expiresAt; }
  }
  listBySession(sessionId: string): ApprovalRow[] { return [...this.rows.values()].filter((r) => r.session_id === sessionId); }
}

const callRow = (callId: string): ToolCallRow => ({
  id: `tc_${callId}`, session_id: 'sess_budget', message_id: 'msg', call_id: callId,
  tool_name: 'fs.write', tool_wire_name: 'fs_write', display_name: '写入文件', category: 'file',
  source: 'builtin', risk: 'high', approval_mode: 'hard', channel: 'native', iteration: 1,
  args_json: JSON.stringify(ARGS), args_digest: digest, status: 'pending', error_kind: null, error_msg: null,
  result_ref: null, result_summary: null, truncated: 0, started_at: null, ended_at: null, duration_ms: 0,
  created_at: Date.now(),
} as ToolCallRow);

function makeService() {
  const approvals = new FakeApprovals();
  const rows = new Map<string, ToolCallRow>();
  const toolCalls = {
    get: (id: string) => rows.get(id),
    insert: (row: ToolCallRow) => { rows.set(row.id, row); return row; },
    listBySession: () => [...rows.values()],
  } as unknown as ToolCallRepository;
  const registry = { get: () => undefined, list: () => [] } as unknown as ToolRegistry;
  const service = new ApprovalService(approvals as unknown as ApprovalRepository, toolCalls, registry, () => ({ sandboxRoot: tmpdir() }));
  return { service, approvals, toolCalls };
}

const events: Array<{ name: string; data: any }> = [];
const sse = { emit: (name: string, data: unknown) => events.push({ name, data }) } as unknown as SseWriter;

afterEach(() => {
  vi.useRealTimers();
  events.length = 0;
});

describe('审批等待受任务 wall-clock deadline 约束', () => {
  it('deadline 早于 TTL → 按 deadline 结算为 expired，不等到 5 分钟', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));
    const { service, approvals } = makeService();
    const deadline = Date.now() + 200;
    const parked = service.requestApproval({
      sessionId: 'sess_budget', toolCall: callRow('call_budget'), args: ARGS,
      digest, reason: '写入需要确认', deadline,
    } as any, sse);
    const event = events.find((e) => e.name === 'tool_approval_required')!;
    expect(approvals.get(event.data.approvalId)!.expires_at).toBeLessThanOrEqual(deadline);

    await vi.advanceTimersByTimeAsync(300);
    await expect(parked).resolves.toBe('expired');
    const row = approvals.get(event.data.approvalId)!;
    expect(row.status).toBe('expired');
    expect(row.status === 'pending').toBe(false);
    expect(row.status === 'decided').toBe(false);
  });

  it('人工 prolong 也不得越过任务 deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));
    const { service, toolCalls } = makeService();
    const deadline = Date.now() + 200;
    const toolCall = callRow('call_prolong');
    toolCalls.insert(toolCall);
    const parked = service.requestApproval({
      sessionId: 'sess_budget', toolCall, args: ARGS,
      digest, reason: '写入需要确认', deadline,
    } as any, sse);
    const event = events.find((e) => e.name === 'tool_approval_required')!;
    const extended = service.prolong(event.data.approvalId, event.data.approvalToken);
    expect(extended.expiresAt).toBeLessThanOrEqual(deadline);
    expect(extended.expiresAt > deadline).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    await expect(parked).resolves.toBe('expired');
  });

  it('没有 deadline 时仍使用审批 TTL（不缩短正常审批窗口）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));
    const { service, approvals } = makeService();
    const parked = service.requestApproval({
      sessionId: 'sess_budget', toolCall: callRow('call_ttl'), args: ARGS, digest, reason: '写入需要确认',
    }, sse);
    const event = events.find((e) => e.name === 'tool_approval_required')!;
    const ttl = approvals.get(event.data.approvalId)!.expires_at - Date.now();
    expect(ttl > 250_000).toBe(true);
    expect(ttl < 250_000).toBe(false);
    service.abortSession('sess_budget');
    await expect(parked).resolves.toBe('aborted');
  });

  it('生产装配把 wall-clock deadline 传给审批', () => {
    const runServices = readFileSync(new URL('../../src/services/agent/run-services.ts', import.meta.url), 'utf8');
    const executor = readFileSync(new URL('../../src/services/tools/executor.service.ts', import.meta.url), 'utf8');
    expect(runServices.includes('approvalDeadline: budget.startedAt + budget.totalBudgetMs')).toBe(true);
    expect(executor.includes('deadline: this.deps.approvalDeadline')).toBe(true);
  });
});
