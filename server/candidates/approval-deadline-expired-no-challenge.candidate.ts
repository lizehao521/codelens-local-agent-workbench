/**
 * Judge · 任务 deadline 已过时不得签发"签发即过期"的审批令牌。
 *
 * 线上症状：B 红队审计跑过 180s 任务预算后写 findings，fs.write 触发 hard 审批。
 * approvalDeadline=startedAt+180000 已是过去，requestApproval 仍签发
 * expiresAt=过去的令牌并发出 SSE；自动批准拿该令牌 submitDecision →
 * verifyApprovalToken=EXPIRED → loadChallenge 吞掉错误码报 APPROVAL_TOKEN_MISMATCH；
 * agent 误判"令牌错误，重试" → 新审批 → 又签发即过期 → 死循环烧 token。
 *
 * 判据钉住正确行为：deadline 已过时 requestApproval 立即 resolve('expired')，
 * 不写审批行、不发 tool_approval_required、不签发令牌。executor 既有分支据此
 * 返回 TOOL_APPROVAL_EXPIRED（已被 approval-expired-tool-success 判据保证不污染成功率）。
 */
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { ApprovalService } from '../src/services/agent/approval.service.js';
import type { ApprovalRepository, ApprovalRow, InsertApprovalInput } from '../src/services/memory/approval.repository.js';
import type { ToolCallRepository, ToolCallRow } from '../src/services/memory/tool-call.repository.js';
import type { ToolRegistry } from '../src/services/tools/registry.service.js';
import type { SseWriter } from '../src/services/agent/sse-writer.js';
import { argsDigest } from '../src/utils/digest.js';

class FakeApprovalRepository {
  readonly rows = new Map<string, ApprovalRow>();
  private seq = 0;
  insert(input: InsertApprovalInput): ApprovalRow {
    const row: ApprovalRow = {
      id: `ap_${(this.seq += 1)}`, session_id: input.sessionId, tool_call_id: input.toolCallId,
      tool_name: input.toolName, args_digest: input.argsDigest, challenge_token_hash: input.challengeTokenHash,
      status: 'pending', decision: null, reason: null, mismatch_count: 0, last_mismatch_at: null,
      last_mismatch_detail: null, revised_from_id: null, revise_depth: 0, expires_at: input.expiresAt,
      decided_at: null, created_at: Date.now(),
    } as ApprovalRow;
    this.rows.set(row.id, row);
    return row;
  }
  get(id: string): ApprovalRow | undefined { return this.rows.get(id); }
  listBySession(): ApprovalRow[] { return []; }
  decide(id: string): ApprovalRow { const r = this.rows.get(id)!; r.status = 'decided'; return r; }
  markRevised(id: string): void { const r = this.rows.get(id)!; r.status = 'revised'; }
  markExpired(id: string): void { const r = this.rows.get(id)!; if (r.status === 'pending') r.status = 'expired'; }
  markAborted(id: string): void { const r = this.rows.get(id)!; r.status = 'aborted'; }
  recordMismatch(): number { return 0; }
  reissue(): void {}
}
class FakeToolCallRepository {
  readonly rows = new Map<string, ToolCallRow>();
  insert(r: ToolCallRow): void { this.rows.set(r.id, r); }
  get(id: string): ToolCallRow | undefined { return this.rows.get(id); }
  markFinished(): void {}
}
const ARGS = { path: 'notes/a.txt', operation: 'create', content: 'x' };
function toolCallRow(callId: string): ToolCallRow {
  return {
    id: `tc_${callId}`, session_id: 'sess_1', message_id: 'msg_1', call_id: callId,
    tool_name: 'fs.write', tool_wire_name: 'fs_write', display_name: '写入文件', category: 'file',
    source: 'builtin', risk: 'high', approval_mode: 'hard', channel: 'native', iteration: 1,
    args_json: JSON.stringify(ARGS), args_digest: argsDigest(ARGS), status: 'pending',
    error_kind: null, error_msg: null, result_ref: null, result_summary: null, truncated: 0,
    started_at: null, finished_at: null, duration_ms: null, created_at: Date.now(),
  } as unknown as ToolCallRow;
}
function makeService() {
  const approvals = new FakeApprovalRepository();
  const toolCalls = new FakeToolCallRepository();
  const registry = { get: () => undefined, list: () => [] } as unknown as ToolRegistry;
  const service = new ApprovalService(
    approvals as unknown as ApprovalRepository, toolCalls as unknown as ToolCallRepository,
    registry, () => ({ sandboxRoot: tmpdir() }),
  );
  return { service, approvals, toolCalls };
}
function challenge(toolCalls: FakeToolCallRepository, callId: string, deadline: number) {
  const toolCall = toolCallRow(callId);
  toolCalls.insert(toolCall);
  return { sessionId: 'sess_1', toolCall, args: ARGS, digest: argsDigest(ARGS), reason: '写入确认', deadline };
}
function fakeSse(events: { name: string; data: any }[]): SseWriter {
  return { emit: (name: string, data: unknown) => { events.push({ name, data }); } } as unknown as SseWriter;
}

describe('deadline 已过时不得签发必然过期的审批令牌', () => {
  it('deadline=过去 → 立即 expired，不写审批行、不发 SSE', async () => {
    const { service, approvals, toolCalls } = makeService();
    const events: { name: string; data: any }[] = [];
    const sse = fakeSse(events);
    const decision = await service.requestApproval(
      challenge(toolCalls, 'call_expired_deadline', Date.now() - 60_000), sse,
    );
    expect(decision).toBe('expired');
    expect(approvals.rows.size).toBe(0); // 没有签发审批行
    expect(events.filter((e) => e.name === 'tool_approval_required').length).toBe(0); // 没有无效令牌下发
  });

  it('deadline=未来 → 正常签发审批并下发 SSE（回归保护）', async () => {
    const { service, approvals, toolCalls } = makeService();
    const events: { name: string; data: any }[] = [];
    const sse = fakeSse(events);
    const pending = service.requestApproval(
      challenge(toolCalls, 'call_valid_deadline', Date.now() + 180_000), sse,
    );
    expect(approvals.rows.size).toBe(1);
    expect(events.filter((e) => e.name === 'tool_approval_required').length).toBe(1);
    // 清理 park，避免 timer 残留
    const row = [...approvals.rows.values()][0]!;
    service.submitDecision(row.id, events.find((e) => e.name === 'tool_approval_required')!.data.approvalToken, 'allow_once', null);
    expect(await pending).toBe('allow_once');
  });
});
