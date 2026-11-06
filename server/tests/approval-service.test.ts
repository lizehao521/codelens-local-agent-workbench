/**
 * Approval service park lifecycle (P1-2 / P1-4 regression net).
 *
 * The approval service had zero direct test coverage (only its repository was
 * tested). These cases pin the two crash/hang defects fixed in the second
 * batch:
 *   P1-4 — re-parking an already-parked callId swapped the park's resolve
 *          without waking the previous waiter, leaving the old executor
 *          awaiting forever.
 *   P1-2 — a failed decision write (and the three-strike abort path) left the
 *          park unresolved for the same reason.
 * Plus the normal decision paths, to guard the settlePark refactor.
 */

import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ApprovalService } from '../src/services/agent/approval.service.js';
import type { ApprovalRepository, ApprovalRow, InsertApprovalInput } from '../src/services/memory/approval.repository.js';
import type { ToolCallRepository, ToolCallRow } from '../src/services/memory/tool-call.repository.js';
import type { ToolRegistry } from '../src/services/tools/registry.service.js';
import type { SseWriter } from '../src/services/agent/sse-writer.js';
import { argsDigest } from '../src/utils/digest.js';
import { issueApprovalToken } from '../src/utils/hmac.js';
import { sha256Hex } from '../src/utils/hash.js';

// ── in-memory fakes ───────────────────────────────────────────────────────────

class FakeApprovalRepository {
  readonly rows = new Map<string, ApprovalRow>();
  failNextDecide = false;
  private seq = 0;

  insert(input: InsertApprovalInput): ApprovalRow {
    const row: ApprovalRow = {
      id: `ap_${(this.seq += 1)}`,
      session_id: input.sessionId,
      tool_call_id: input.toolCallId,
      tool_name: input.toolName,
      args_digest: input.argsDigest,
      challenge_token_hash: input.challengeTokenHash,
      status: 'pending',
      decision: null,
      reason: null,
      mismatch_count: 0,
      last_mismatch_at: null,
      last_mismatch_detail: null,
      revised_from_id: input.revisedFromId ?? null,
      revise_depth: input.reviseDepth ?? 0,
      expires_at: input.expiresAt,
      decided_at: null,
      created_at: Date.now(),
    };
    this.rows.set(row.id, row);
    return row;
  }

  get(id: string): ApprovalRow | undefined {
    return this.rows.get(id);
  }

  listBySession(sessionId: string): ApprovalRow[] {
    return [...this.rows.values()].filter((row) => row.session_id === sessionId);
  }

  decide(id: string, decision: 'allow_once' | 'allow_session' | 'reject', reason: string | null): ApprovalRow {
    if (this.failNextDecide) {
      this.failNextDecide = false;
      throw new Error('DB write failed');
    }
    const row = this.rows.get(id)!;
    row.decision = decision;
    row.status = 'decided';
    row.reason = reason;
    row.decided_at = Date.now();
    return row;
  }

  markRevised(id: string): void {
    const row = this.rows.get(id)!;
    row.decision = 'revised';
    row.status = 'revised';
  }

  markExpired(id: string): void {
    const row = this.rows.get(id)!;
    if (row.status === 'pending') row.status = 'expired';
  }

  markAborted(id: string): void {
    const row = this.rows.get(id)!;
    if (row.status === 'pending') row.status = 'aborted';
  }

  reissue(id: string, tokenHash: string, expiresAt: number): void {
    const row = this.rows.get(id)!;
    row.challenge_token_hash = tokenHash;
    row.expires_at = expiresAt;
  }

  recordMismatch(id: string, detail: string): number {
    const row = this.rows.get(id)!;
    row.mismatch_count += 1;
    row.last_mismatch_detail = detail;
    return row.mismatch_count;
  }
}

class FakeToolCallRepository {
  readonly rows = new Map<string, ToolCallRow>();

  get(id: string): ToolCallRow | undefined {
    return this.rows.get(id);
  }

  listBySession(): ToolCallRow[] {
    return [...this.rows.values()];
  }

  insert(row: ToolCallRow): ToolCallRow {
    this.rows.set(row.id, row);
    return row;
  }

  markFinished(id: string, patch: Partial<ToolCallRow>): void {
    const row = this.rows.get(id);
    if (row) Object.assign(row, patch);
  }
}

interface FakeEvent {
  name: string;
  data: any;
}

function fakeSse(events: FakeEvent[]): SseWriter {
  return {
    emit: (name: string, data: unknown) => {
      events.push({ name, data });
    },
  } as unknown as SseWriter;
}

const ARGS = { path: 'notes/a.txt', operation: 'create', content: 'x' };

function toolCallRow(callId: string): ToolCallRow {
  return {
    id: `tc_${callId}`,
    session_id: 'sess_1',
    message_id: 'msg_1',
    call_id: callId,
    tool_name: 'fs.write',
    tool_wire_name: 'fs_write',
    display_name: '写入文件',
    category: 'file',
    source: 'builtin',
    risk: 'medium',
    approval_mode: 'soft',
    channel: 'native',
    iteration: 1,
    args_json: JSON.stringify(ARGS),
    args_digest: argsDigest(ARGS),
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

function makeService() {
  const approvals = new FakeApprovalRepository();
  const toolCalls = new FakeToolCallRepository();
  const registry = { get: () => undefined, list: () => [] } as unknown as ToolRegistry;
  const service = new ApprovalService(
    approvals as unknown as ApprovalRepository,
    toolCalls as unknown as ToolCallRepository,
    registry,
    () => ({ sandboxRoot: tmpdir() }),
  );
  return { service, approvals, toolCalls };
}

function challengeFor(toolCalls: FakeToolCallRepository, callId: string) {
  const toolCall = toolCallRow(callId);
  toolCalls.insert(toolCall);
  return {
    sessionId: 'sess_1',
    toolCall,
    args: ARGS,
    digest: argsDigest(ARGS),
    reason: '写入操作需要确认',
  };
}

function approvalEvent(events: FakeEvent[], index = 0): FakeEvent {
  return events.filter((event) => event.name === 'tool_approval_required')[index];
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ApprovalService park lifecycle (P1-2 / P1-4)', () => {
  it('P1-4: re-parking the same callId wakes the superseded waiter instead of orphaning it', async () => {
    const { service, toolCalls } = makeService();
    const events: FakeEvent[] = [];
    const sse = fakeSse(events);

    const first = service.requestApproval(challengeFor(toolCalls, 'call_park'), sse);
    const second = service.requestApproval(challengeFor(toolCalls, 'call_park'), sse);

    // The first waiter must settle. Before the fix its resolve was swapped out
    // and it awaited forever (only the 180s task budget ended the hang).
    await expect(first).resolves.toBe('aborted');

    // The fresh park is live: deciding the SECOND challenge settles the second waiter.
    const secondEvent = approvalEvent(events, 1);
    expect(secondEvent.data.approvalId).not.toBe(approvalEvent(events, 0).data.approvalId);
    const result = service.submitDecision(secondEvent.data.approvalId, secondEvent.data.approvalToken, 'allow_once', null);
    expect(result.status).toBe('executed');
    await expect(second).resolves.toBe('allow_once');
  });

  it('P1-2: a failed decision write settles the park as rejected instead of hanging the executor', async () => {
    const { service, approvals, toolCalls } = makeService();
    const events: FakeEvent[] = [];
    const sse = fakeSse(events);

    const parked = service.requestApproval(challengeFor(toolCalls, 'call_write_fail'), sse);
    const event = approvalEvent(events);

    approvals.failNextDecide = true;
    expect(() => service.submitDecision(event.data.approvalId, event.data.approvalToken, 'allow_once', null)).toThrow(
      'DB write failed',
    );

    // The executor must be fed back instead of awaiting a decision that will never come.
    await expect(parked).resolves.toBe('reject');
  });

  it('P1-2: three token mismatches abort the challenge AND wake the parked executor', async () => {
    const { service, approvals, toolCalls } = makeService();
    const events: FakeEvent[] = [];
    const sse = fakeSse(events);

    const parked = service.requestApproval(challengeFor(toolCalls, 'call_strikes'), sse);
    const event = approvalEvent(events);

    for (let i = 0; i < 3; i += 1) {
      expect(() => service.submitDecision(event.data.approvalId, 'forged-token', 'allow_once', null)).toThrowError(
        expect.objectContaining({ code: 'APPROVAL_TOKEN_MISMATCH' }),
      );
    }

    await expect(parked).resolves.toBe('aborted');
    const row = approvals.get(event.data.approvalId)!;
    expect(row.status).toBe('aborted');
    expect(row.mismatch_count).toBe(3);
  });

  it('allow_once / allow_session / reject still settle the park correctly (settlePark regression net)', async () => {
    for (const decision of ['allow_once', 'allow_session', 'reject'] as const) {
      const { service, approvals, toolCalls } = makeService();
      const events: FakeEvent[] = [];
      const sse = fakeSse(events);
      const callId = `call_${decision}`;

      const parked = service.requestApproval(challengeFor(toolCalls, callId), sse);
      const event = approvalEvent(events);
      const result = service.submitDecision(event.data.approvalId, event.data.approvalToken, decision, null);

      await expect(parked).resolves.toBe(decision);
      expect(result.decision).toBe(decision);
      expect(result.status).toBe(decision === 'reject' ? 'rejected' : 'executed');

      const row = approvals.get(event.data.approvalId)!;
      expect(row.status).toBe('decided');
      if (decision === 'allow_session') {
        expect(service.hasSessionGrant('sess_1', 'fs.write', argsDigest(ARGS))).toBe(true);
      }
    }
  });

  it('expired token: marks expired, settles the park, and rejects the submission', async () => {
    const { service, approvals, toolCalls } = makeService();
    const events: FakeEvent[] = [];
    const sse = fakeSse(events);

    const parked = service.requestApproval(challengeFor(toolCalls, 'call_expired'), sse);
    const event = approvalEvent(events);

    // Force the stored expiry into the past (the 5-minute TTL in fast-forward).
    approvals.get(event.data.approvalId)!.expires_at = Date.now() - 1000;

    expect(() => service.submitDecision(event.data.approvalId, event.data.approvalToken, 'allow_once', null)).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_EXPIRED' }),
    );
    await expect(parked).resolves.toBe('expired');
    expect(approvals.get(event.data.approvalId)!.status).toBe('expired');
  });
});

describe('ApprovalService.prolong (AUDIT-009)', () => {
  function setupPending(expiresAt: number) {
    const { service, approvals, toolCalls } = makeService();
    const callId = 'prolong_call';
    const args = { path: 'notes/a.txt' };
    const digest = argsDigest(args);
    const toolCall = toolCallRow(callId);
    toolCall.args_json = JSON.stringify(args);
    toolCall.args_digest = digest;
    toolCalls.insert(toolCall);
    const token = issueApprovalToken({
      sessionId: 'sess_1',
      toolCallId: `tc_${callId}`,
      toolName: 'fs.write',
      argsDigestValue: digest,
      expiresAt,
    }).token;
    const row: ApprovalRow = {
      id: 'ap_prolong',
      session_id: 'sess_1',
      tool_call_id: `tc_${callId}`,
      tool_name: 'fs.write',
      args_digest: digest,
      challenge_token_hash: 'stale-hash',
      status: 'pending',
      decision: null,
      reason: null,
      mismatch_count: 0,
      last_mismatch_at: null,
      last_mismatch_detail: null,
      revised_from_id: null,
      revise_depth: 0,
      expires_at: expiresAt,
      decided_at: null,
      created_at: Date.now(),
    };
    approvals.rows.set('ap_prolong', row);
    return { service, approvals, token };
  }

  it('有效未过期令牌 → 返回新令牌与更晚的过期时间，并改写存储哈希', () => {
    const { service, approvals, token } = setupPending(Date.now() + 60_000);
    const result = service.prolong('ap_prolong', token);
    expect(result.approvalId).toBe('ap_prolong');
    expect(result.approvalToken).not.toBe(token);
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 30_000);
    expect(approvals.rows.get('ap_prolong')!.challenge_token_hash).toBe(sha256Hex(result.approvalToken));
  });

  it('已过期令牌 → APPROVAL_EXPIRED，不重新签发', () => {
    // 与 submitDecision 过期用例一致：令牌仍合法，仅行级 expires_at 被回拨到过去，
    // 触发 prolong 的「行已过期」分支（令牌内嵌过期由 HMAC 校验先行拦截为 TOKEN_MISMATCH）。
    const { service, approvals, token } = setupPending(Date.now() + 60_000);
    approvals.rows.get('ap_prolong')!.expires_at = Date.now() - 1000;
    expect(() => service.prolong('ap_prolong', token)).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_EXPIRED' }),
    );
  });

  it('已决定（status≠pending）→ APPROVAL_ALREADY_DECIDED', () => {
    const { service, approvals, token } = setupPending(Date.now() + 60_000);
    approvals.rows.get('ap_prolong')!.status = 'decided';
    expect(() => service.prolong('ap_prolong', token)).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_ALREADY_DECIDED' }),
    );
  });

  it('伪造令牌 → APPROVAL_TOKEN_MISMATCH', () => {
    const { service } = setupPending(Date.now() + 60_000);
    expect(() => service.prolong('ap_prolong', 'forged-token')).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_TOKEN_MISMATCH' }),
    );
  });
});
