/**
 * Approval service (AC-04 / AC-06): challenge lifecycle, HMAC token verification,
 * anomaly audit, and the parameter-revision flow (AC-10, independent endpoint).
 *
 * Server-side holding: the client only ever submits {token, decision} — never the
 * arguments. Mismatch submissions increment mismatch_count; three strikes abort
 * the challenge. Every decision write goes through the repository's write-once
 * guard, which asserts `changes === 1` (the silent no-op hazard).
 *
 * Parking model: the agent loop parks once per (sessionId, callId) — NOT per
 * approval row. A revision that needs re-approval swaps the challenge under the
 * same park, so the loop never sees the swap; a revision that drops the risk to
 * `none` resolves the park with 'revised_direct' and the executor re-reads the
 * successor row (same callId) and runs that.
 */

import { sha256Hex, safeEqualHex } from '../../utils/hash.js';
import { APPROVAL_TTL_MS, issueApprovalToken, verifyApprovalToken } from '../../utils/hmac.js';
import { argsDigest } from '../../utils/digest.js';
import type { ApprovalRepository, ApprovalRow } from '../memory/approval.repository.js';
import type { ToolCallRepository, ToolCallRow } from '../memory/tool-call.repository.js';
import type { ToolRegistry } from '../tools/registry.service.js';
import type { SseWriter } from './sse-writer.js';
import { runGateway, type GatewayContext } from '../tools/security-gateway.js';
import type { EffectPreview } from '../../types/tool.js';
import { AppError } from '../../utils/errors.js';

export interface ApprovalChallengeRequest {
  sessionId: string;
  toolCall: ToolCallRow;
  args: Record<string, unknown>;
  digest: string;
  reason: string;
  /** 不可逆操作的后果预览（审批主视图）。 */
  effect?: EffectPreview | null;
  /** E：审批行创建后回调 id，供去重登记「沿用的是哪一次授权」。 */
  onIssued?: (approvalId: string) => void;
}

export type ParkedDecision =
  | 'allow_once'
  | 'allow_session'
  | 'reject'
  | 'expired'
  | 'aborted'
  | 'revised_direct';

interface CallPark {
  resolve: (decision: ParkedDecision) => void;
  timer: NodeJS.Timeout;
}

export interface SubmitDecisionResult {
  approvalId: string;
  decision: 'allow_once' | 'allow_session' | 'reject';
  status: 'executed' | 'rejected';
  toolCallId: string;
}

export interface ReviseResult {
  status: 'reapproval_required' | 'executed_directly';
  approvalId: string | null;
  toolCallId: string;
}

function parkKey(sessionId: string, callId: string): string {
  return `${sessionId}:${callId}`;
}

export class ApprovalService {
  /** sessionId → "toolName:argsDigest" granted for this process lifetime only. */
  private readonly sessionGrants = new Map<string, Set<string>>();
  /** parkKey → the loop-level promise the executor is awaiting. */
  private readonly callParks = new Map<string, CallPark>();
  /** approvalId → parkKey (which loop park this challenge serves). */
  private readonly approvalToPark = new Map<string, string>();
  /** sessionId → the live SSE writer of the task that owns its challenges. */
  private readonly writers = new Map<string, SseWriter>();

  constructor(
    private readonly approvals: ApprovalRepository,
    private readonly toolCalls: ToolCallRepository,
    private readonly registry: ToolRegistry,
    private readonly gatewayCtx: () => GatewayContext,
  ) {}

  /**
   * P1-2: resolves and cleans up the park serving an approval row (idempotent).
   * Every path that can end a challenge — decision, expiry, three-strike
   * abort, revision — must settle through here, so no executor is ever left
   * awaiting a promise that can no longer be settled.
   */
  private settlePark(approvalId: string, decision: ParkedDecision): void {
    const key = this.approvalToPark.get(approvalId);
    if (!key) return;
    const park = this.callParks.get(key);
    if (park) {
      clearTimeout(park.timer);
      this.callParks.delete(key);
      park.resolve(decision);
    }
    this.approvalToPark.delete(approvalId);
  }

  /** Registers the stream that challenge events for this session must flow on. */
  attachWriter(sessionId: string, writer: SseWriter): void {
    this.writers.set(sessionId, writer);
  }

  detachWriter(sessionId: string): void {
    this.writers.delete(sessionId);
  }

  private writerFor(sessionId: string): SseWriter | undefined {
    return this.writers.get(sessionId);
  }

  hasSessionGrant(sessionId: string, toolName: string, digest: string): boolean {
    return this.sessionGrants.get(sessionId)?.has(`${toolName}:${digest}`) ?? false;
  }

  private addSessionGrant(sessionId: string, toolName: string, digest: string): void {
    const grants = this.sessionGrants.get(sessionId) ?? new Set<string>();
    grants.add(`${toolName}:${digest}`);
    this.sessionGrants.set(sessionId, grants);
  }

  /** Issues a challenge and parks the tool call until the user decides. */
  async requestApproval(req: ApprovalChallengeRequest, sse: SseWriter): Promise<ParkedDecision> {
    const key = parkKey(req.sessionId, req.toolCall.call_id);
    this.attachWriter(req.sessionId, sse);
    const { token, tokenHash, expiresAt } = issueApprovalToken({
      sessionId: req.sessionId,
      toolCallId: req.toolCall.id,
      toolName: req.toolCall.tool_name,
      argsDigestValue: req.digest,
      expiresAt: Date.now() + APPROVAL_TTL_MS,
    });
    const row = this.approvals.insert({
      sessionId: req.sessionId,
      toolCallId: req.toolCall.id,
      toolName: req.toolCall.tool_name,
      argsDigest: req.digest,
      challengeTokenHash: tokenHash,
      expiresAt,
    });
    this.approvalToPark.set(row.id, key);
    req.onIssued?.(row.id);
    sse.emit('tool_approval_required', {
      callId: req.toolCall.call_id,
      name: req.toolCall.tool_name,
      displayName: req.toolCall.display_name,
      arguments: req.args,
      risk: req.toolCall.risk as 'low' | 'medium' | 'high',
      approvalMode: req.toolCall.approval_mode as 'none' | 'soft' | 'hard' | 'two_step',
      reason: req.reason,
      effect: req.effect ?? null,
      approvalId: row.id,
      approvalToken: token,
      expiresAt,
    });

    const existing = this.callParks.get(key);
    if (existing) {
      // P1-4: a previous request already parked this callId. With the
      // per-session serialization guard (P0-2) this should not happen; if a
      // stale park still exists (e.g. a superseded run), the old waiter MUST
      // be woken — swapping `resolve` without settling the old promise left
      // the previous executor awaiting forever. Drop the stale park and park
      // afresh below.
      clearTimeout(existing.timer);
      this.callParks.delete(key);
      existing.resolve('aborted');
      // Drop the stale approval→park mappings — but never the one just
      // registered for the new challenge above (it maps to this same key).
      for (const [approvalId, mappedKey] of [...this.approvalToPark.entries()]) {
        if (mappedKey === key && approvalId !== row.id) this.approvalToPark.delete(approvalId);
      }
    }
    return new Promise<ParkedDecision>((resolve) => {
      const park: CallPark = {
        resolve,
        timer: this.armExpiry(row.id, key, expiresAt, resolve),
      };
      this.callParks.set(key, park);
    });
  }

  private armExpiry(
    approvalId: string,
    key: string,
    expiresAt: number,
    resolve: (decision: ParkedDecision) => void,
  ): NodeJS.Timeout {
    return setTimeout(() => {
      this.approvalToPark.delete(approvalId);
      this.callParks.delete(key);
      this.approvals.markExpired(approvalId);
      resolve('expired');
    }, Math.max(0, expiresAt - Date.now()) + 50);
  }

  /** Shared validation chain (order fixed; any failure throws AppError). */
  private loadChallenge(approvalId: string, token: string): { row: ApprovalRow; toolCall: ToolCallRow } {
    const row = this.approvals.get(approvalId);
    if (!row) throw new AppError('APPROVAL_NOT_FOUND', '审批不存在或已失效');
    if (row.status !== 'pending') {
      throw new AppError('APPROVAL_ALREADY_DECIDED', '该审批已处理，不能重复提交');
    }
    const toolCall = this.toolCalls.get(row.tool_call_id);
    if (!toolCall) throw new AppError('APPROVAL_NOT_FOUND', '关联的工具调用不存在');

    // HMAC signature first (cheap, no DB), then the stored hash.
    const verified = verifyApprovalToken(token, {
      sessionId: row.session_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      argsDigestValue: row.args_digest,
    });
    const hashOk = safeEqualHex(sha256Hex(token), row.challenge_token_hash);
    if (!verified.ok || !hashOk) {
      const strikes = this.approvals.recordMismatch(row.id, 'TOKEN_MISMATCH');
      if (strikes >= 3) {
        this.approvals.markAborted(row.id);
        // Three strikes end the challenge: wake the parked executor too, or it
        // waits for a decision that can no longer arrive (P1-2).
        this.settlePark(row.id, 'aborted');
      }
      throw new AppError('APPROVAL_TOKEN_MISMATCH', '审批令牌校验失败');
    }

    if (Date.now() > row.expires_at) {
      this.approvals.markExpired(row.id);
      this.settlePark(row.id, 'expired');
      throw new AppError('APPROVAL_EXPIRED', '审批已过期（5 分钟有效期）');
    }

    // Parameter digest recheck: the server-held args must match the challenge.
    let currentArgs: Record<string, unknown> = {};
    try {
      currentArgs = JSON.parse(toolCall.args_json) as Record<string, unknown>;
    } catch {
      currentArgs = {};
    }
    if (argsDigest(currentArgs) !== row.args_digest) {
      const strikes = this.approvals.recordMismatch(row.id, 'ARGS_MISMATCH');
      if (strikes >= 3) {
        this.approvals.markAborted(row.id);
        this.settlePark(row.id, 'aborted');
      }
      throw new AppError('APPROVAL_ARGS_MISMATCH', '待执行参数与服务端持有记录不一致');
    }
    return { row, toolCall };
  }

  /** POST /api/v1/approvals/:id — decisions only, never arguments. */
  submitDecision(
    approvalId: string,
    token: string,
    decision: 'allow_once' | 'allow_session' | 'reject',
    reason: string | null,
  ): SubmitDecisionResult {
    const { row } = this.loadChallenge(approvalId, token);
    try {
      this.approvals.decide(row.id, decision, decision === 'reject' ? (reason ?? '用户拒绝') : reason);
    } catch (err) {
      // P1-2: a failed decision write must never leave the loop parked. Settle
      // as rejected so the executor feeds the failure back to the LLM instead
      // of hanging until the task budget expires; the write error still
      // surfaces to the client as before.
      this.settlePark(row.id, 'reject');
      throw err;
    }
    if (decision === 'allow_session') {
      this.addSessionGrant(row.session_id, row.tool_name, row.args_digest);
    }
    this.settlePark(row.id, decision);
    return {
      approvalId: row.id,
      decision,
      status: decision === 'reject' ? 'rejected' : 'executed',
      toolCallId: row.tool_call_id,
    };
  }

  /**
   * AUDIT-009: extends a still-pending approval's life so a present-but-slow
   * human reviewer is never defeated by the 5-minute hard timeout (which would
   * otherwise auto-reject the tool call and let the agent proceed unattended).
   * Returns a fresh token + expiry; the in-memory park timer is re-armed so the
   * server keeps waiting for the decision instead of expiring.
   */
  prolong(approvalId: string, token: string): { approvalId: string; approvalToken: string; expiresAt: number } {
    const row = this.approvals.get(approvalId);
    if (!row) throw new AppError('APPROVAL_NOT_FOUND', '审批不存在或已失效');
    if (row.status !== 'pending') {
      throw new AppError('APPROVAL_ALREADY_DECIDED', '该审批已处理，不能重复提交');
    }
    const toolCall = this.toolCalls.get(row.tool_call_id);
    if (!toolCall) throw new AppError('APPROVAL_NOT_FOUND', '关联的工具调用不存在');

    const verified = verifyApprovalToken(token, {
      sessionId: row.session_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      argsDigestValue: row.args_digest,
    });
    if (!verified.ok) {
      throw new AppError('APPROVAL_TOKEN_MISMATCH', '审批令牌校验失败');
    }
    if (Date.now() > row.expires_at) {
      this.approvals.markExpired(row.id);
      this.settlePark(row.id, 'expired');
      throw new AppError('APPROVAL_EXPIRED', '审批已过期（5 分钟有效期）');
    }

    const { token: newToken, tokenHash, expiresAt } = issueApprovalToken({
      sessionId: row.session_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      argsDigestValue: row.args_digest,
      expiresAt: 0,
    });
    this.approvals.reissue(row.id, tokenHash, expiresAt);

    // Re-arm the in-memory expiry timer so the parked executor keeps waiting
    // for the (now-extended) decision instead of resolving as 'expired'.
    const key = this.approvalToPark.get(row.id);
    if (key) {
      const park = this.callParks.get(key);
      if (park) {
        clearTimeout(park.timer);
        park.timer = this.armExpiry(row.id, key, expiresAt, park.resolve);
      }
    }

    return { approvalId: row.id, approvalToken: newToken, expiresAt };
  }

  /** Number of revisions already applied to a callId (chain walk, ≤3 enforced). */
  private revisionDepth(sessionId: string, callId: string): number {
    return this.toolCalls.listBySession(sessionId).filter((row) => row.call_id === callId && row.error_kind === 'revised').length;
  }

  /**
   * POST /api/v1/approvals/:id/revise — AC-10 parameter revision (independent endpoint).
   * New arguments must re-pass schema validation AND the security gateway: editing
   * parameters is otherwise a sanctioned backdoor around the sandbox.
   */
  revise(approvalId: string, token: string, newArgs: Record<string, unknown>): ReviseResult {
    const { row, toolCall } = this.loadChallenge(approvalId, token);
    const sse = this.writerFor(row.session_id);
    if (!sse) {
      throw new AppError('APPROVAL_ALREADY_DECIDED', '任务流已结束，无法修改参数');
    }

    if (toolCall.status !== 'pending') {
      throw new AppError('APPROVAL_NOT_REVISABLE', '该调用已开始执行，不能修改参数');
    }
    if (this.revisionDepth(row.session_id, toolCall.call_id) >= 3) {
      throw new AppError('APPROVAL_REVISE_LIMIT', '该调用改参数次数已达上限（3 次）');
    }

    const def = this.registry.get(toolCall.tool_name);
    if (!def) throw new AppError('TOOL_NOT_FOUND', `工具 ${toolCall.tool_name} 不在注册表中`);

    // Gate the NEW arguments: schema + sandbox/SSRF + fresh risk verdict.
    const gate = runGateway(def, newArgs, this.gatewayCtx());
    if (!gate.ok) {
      // The revised call fails and is fed back to the LLM — no retry budget burn
      // for security/invalid_args (AC-08 second clause).
      this.toolCalls.markFinished(toolCall.id, {
        status: 'failed',
        errorKind: gate.code === 'SECURITY_DENIED' ? 'security' : 'invalid_args',
        errorMsg: gate.message,
      });
      this.approvals.markRevised(row.id);
      sse.emit('tool_result', {
        callId: toolCall.call_id,
        name: toolCall.tool_name,
        status: 'failed',
        summary: `改参数未通过校验：${gate.message}`,
        data: null,
        truncated: false,
        durationMs: 0,
        resultId: '',
        error: {
          code: gate.code === 'SECURITY_DENIED' ? 'TOOL_SECURITY_DENIED' : 'TOOL_INVALID_ARGS',
          kind: gate.code === 'SECURITY_DENIED' ? 'security' : 'invalid_args',
          message: gate.message,
          retryable: false,
        },
      });
      this.settlePark(row.id, 'reject'); // loop feeds the failure back to the LLM
      throw new AppError('VALIDATION_ERROR', `新参数未通过校验：${gate.message}`);
    }

    this.approvals.markRevised(row.id);
    this.toolCalls.markFinished(toolCall.id, {
      status: 'skipped',
      errorKind: 'revised',
      errorMsg: '用户改参数后重提',
    });

    // New audit row: same iteration, new id, new digest, linked to the old challenge.
    const newDigest = argsDigest(gate.args);
    const newRow = this.toolCalls.insert({
      sessionId: toolCall.session_id,
      messageId: toolCall.message_id,
      callId: toolCall.call_id,
      toolName: toolCall.tool_name,
      toolWireName: toolCall.tool_wire_name,
      displayName: toolCall.display_name,
      category: toolCall.category,
      source: toolCall.source,
      risk: gate.verdict.risk,
      approvalMode: gate.verdict.approvalMode,
      channel: toolCall.channel as 'native' | 'react',
      iteration: toolCall.iteration,
      argsJson: JSON.stringify(gate.args),
      argsDigest: newDigest,
    });

    const key = parkKey(row.session_id, toolCall.call_id);
    const park = this.callParks.get(key);

    if (gate.verdict.approvalMode !== 'none') {
      const { token: newToken, tokenHash, expiresAt } = issueApprovalToken({
        sessionId: row.session_id,
        toolCallId: newRow.id,
        toolName: newRow.tool_name,
        argsDigestValue: newDigest,
        expiresAt: Date.now() + APPROVAL_TTL_MS,
      });
      const newApproval = this.approvals.insert({
        sessionId: row.session_id,
        toolCallId: newRow.id,
        toolName: newRow.tool_name,
        argsDigest: newDigest,
        challengeTokenHash: tokenHash,
        expiresAt,
        revisedFromId: row.id,
        reviseDepth: row.revise_depth + 1,
      });
      this.approvalToPark.delete(row.id);
      this.approvalToPark.set(newApproval.id, key);
      sse.emit('tool_approval_required', {
        callId: newRow.call_id,
        name: newRow.tool_name,
        displayName: newRow.display_name,
        arguments: gate.args,
        risk: gate.verdict.risk,
        approvalMode: gate.verdict.approvalMode,
        reason: gate.verdict.reason ?? '参数已修改，需要重新确认',
        effect: gate.verdict.effect ?? null,
        approvalId: newApproval.id,
        approvalToken: newToken,
        expiresAt,
      });
      // Keep the loop parked on the same promise; only the timer is re-armed.
      if (park) {
        clearTimeout(park.timer);
        park.timer = this.armExpiry(newApproval.id, key, expiresAt, park.resolve);
      }
      return { status: 'reapproval_required', approvalId: newApproval.id, toolCallId: newRow.id };
    }

    // Risk dropped to none: execute directly. Resolve the park with the marker and
    // let the executor pick up the successor row (same callId, approvalMode none).
    this.settlePark(row.id, 'revised_direct');
    return { status: 'executed_directly', approvalId: null, toolCallId: newRow.id };
  }

  /** Aborts every pending challenge of a session (client disconnect / task abort). */
  abortSession(sessionId: string): void {
    for (const [approvalId, key] of [...this.approvalToPark.entries()]) {
      const row = this.approvals.get(approvalId);
      if (row?.session_id !== sessionId) continue;
      const park = this.callParks.get(key);
      if (park) {
        clearTimeout(park.timer);
        this.callParks.delete(key);
        park.resolve('aborted');
      }
      this.approvalToPark.delete(approvalId);
      this.approvals.markAborted(approvalId);
    }
  }
}
