/**
 * Sessions controller: CRUD + recovery codes + cross-browser recovery (AC-05).
 * The recovery code is returned in plaintext EXACTLY once (on create / regenerate).
 */

import type { Request, Response } from 'express';
import { AppError } from '../utils/errors.js';
import type { SessionRepository, SessionRow } from '../services/memory/session.repository.js';
import type { MessageRepository } from '../services/memory/message.repository.js';
import type { ToolCallRepository } from '../services/memory/tool-call.repository.js';
import type { ApprovalRepository } from '../services/memory/approval.repository.js';
import type { ChannelRouter } from '../services/agent/channel-router.service.js';
import type { RecoveryService } from '../services/recovery.service.js';
import { generateRecoveryCode, recoveryCodeHash } from '../services/recovery.service.js';
import { sha256Hex } from '../utils/hash.js';
import {
  CreateSessionSchema,
  PatchSessionSchema,
  RecoverSessionSchema,
  SessionIdParamSchema,
  SessionListQuerySchema,
} from '../validators/session.schema.js';

function publicSession(row: SessionRow) {
  return {
    id: row.id,
    title: row.title,
    provider: row.provider,
    model: row.model,
    channelMode: row.channel_mode,
    degraded: row.degraded === 1,
    messageCount: row.message_count,
    totalTokens: row.total_tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 损坏的 JSON 字段返回 null 而非抛出，避免整条会话详情 500（AUDIT-017）。 */
function safeParseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export class SessionsController {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly messages: MessageRepository,
    private readonly toolCalls: ToolCallRepository,
    private readonly approvals: ApprovalRepository,
    private readonly recovery: RecoveryService,
    private readonly channelRouter: ChannelRouter,
  ) {}

  list(req: Request, res: Response): void {
    const parsed = SessionListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', '分页参数不合法', 400);
    const deviceHeader = req.header('X-Device-Token');
    // AUDIT-018 fail-closed：无设备标识时不返回任何会话，否则列表越权泄露他人会话。
    if (!deviceHeader) {
      res.json({ items: [], total: 0, limit: parsed.data.limit, offset: parsed.data.offset, hasMore: false });
      return;
    }
    const deviceTokenHash = sha256Hex(deviceHeader);
    const { items, total } = this.sessions.list(parsed.data.limit, parsed.data.offset, deviceTokenHash);
    res.json({
      items: items.map(publicSession),
      total,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      hasMore: parsed.data.offset + items.length < total,
    });
  }

  create(req: Request, res: Response): void {
    const parsed = CreateSessionSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'provider/model 必填', 400);
    const deviceToken = `dt_${sha256Hex(`${Date.now()}:${Math.random()}`).slice(0, 24)}`;
    const recoveryCode = generateRecoveryCode();
    const session = this.sessions.create({
      provider: parsed.data.provider,
      model: parsed.data.model,
      title: parsed.data.title,
      deviceTokenHash: sha256Hex(deviceToken),
      recoveryCodeHash: recoveryCodeHash(recoveryCode, ''), // placeholder; re-hashed below with the real id
    });
    // The hash is salted with the session id, so it must be computed after insert.
    this.sessions.setRecoveryCode(session.id, recoveryCodeHash(recoveryCode, session.id));
    res.status(201).json({ session: publicSession(session), recoveryCode, deviceToken });
  }

  recover(req: Request, res: Response): void {
    const parsed = RecoverSessionSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', '恢复码格式不合法（8 位，不含 0/O/1/I）', 400);
    const { sessionId, deviceToken } = this.recovery.recover(parsed.data.recoveryCode, parsed.data.deviceToken);
    const session = this.sessions.get(sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', '会话不存在或已被删除', 404);
    res.json({ session: publicSession(session), deviceToken });
  }

  regenerateRecoveryCode(req: Request, res: Response): void {
    const params = SessionIdParamSchema.safeParse(req.params);
    if (!params.success) throw new AppError('VALIDATION_ERROR', 'sessionId 不合法', 400);
    const recoveryCode = this.recovery.regenerate(params.data.id);
    res.json({ recoveryCode, expiresNote: '旧恢复码已立即失效' });
  }

  /** AUDIT-018：会话绑定了设备令牌哈希时，必须同源设备才能访问；历史空哈希（早于设备绑定机制）放行。 */
  private assertOwned(session: SessionRow, req: Request): void {
    if (!session.device_token_hash) return;
    const deviceHeader = req.header('X-Device-Token');
    const deviceTokenHash = deviceHeader ? sha256Hex(deviceHeader) : null;
    if (deviceTokenHash !== session.device_token_hash) {
      throw new AppError('SESSION_ACCESS_DENIED', '无权访问该会话', 403);
    }
  }

  detail(req: Request, res: Response): void {
    const params = SessionIdParamSchema.safeParse(req.params);
    if (!params.success) throw new AppError('VALIDATION_ERROR', 'sessionId 不合法', 400);
    const session = this.sessions.get(params.data.id);
    if (!session) throw new AppError('SESSION_NOT_FOUND', '会话不存在或已被删除', 404);
    this.assertOwned(session, req);
    const messages = this.messages.listBySession(session.id).map((row) => ({
      id: row.id,
      seq: row.seq,
      role: row.role,
      content: row.content,
      segments: safeParseJson(row.segments_json),
      tokens: row.tokens,
      isSummary: row.is_summary === 1,
      createdAt: row.created_at,
    }));
    const toolCalls = this.toolCalls.listBySession(session.id).map((row) => ({
      id: row.id,
      callId: row.call_id,
      // message_id 即「segments 含该 tool 段的 assistant 消息」——前端回看时按它
      // 把审计行挂回消息（P1-6）；删消息时 ON DELETE SET NULL，为空即无所属消息。
      messageId: row.message_id,
      toolName: row.tool_name,
      displayName: row.display_name,
      category: row.category,
      source: row.source,
      risk: row.risk,
      approvalMode: row.approval_mode,
      channel: row.channel,
      iteration: row.iteration,
      arguments: safeParseJson(row.args_json),
      status: row.status,
      resultSummary: row.result_summary,
      resultRef: row.result_ref,
      durationMs: row.duration_ms,
      truncated: row.truncated === 1,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      errorKind: row.error_kind,
      errorMessage: row.error_msg,
    }));
    const approvals = this.approvals.listBySession(session.id).map((row) => ({
      id: row.id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      status: row.status,
      decision: row.decision,
      decidedAt: row.decided_at,
    }));
    // AUDIT-028 投影：精确 token 用量（messages.usage_json 聚合），与 total_tokens 估值并存。
    const usage = this.messages.usageBySession(session.id);
    res.json({
      session: publicSession(session),
      messages,
      toolCalls,
      approvals,
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.promptTokens + usage.completionTokens,
      },
    });
  }

  /** AUDIT-028 对账端点：只读，返回精确 token 用量总量 + 按消息明细。 */
  usage(req: Request, res: Response): void {
    const params = SessionIdParamSchema.safeParse(req.params);
    if (!params.success) throw new AppError('VALIDATION_ERROR', 'sessionId 不合法', 400);
    const session = this.sessions.get(params.data.id);
    if (!session) throw new AppError('SESSION_NOT_FOUND', '会话不存在或已被删除', 404);
    this.assertOwned(session, req);
    const usage = this.messages.usageBySession(session.id);
    res.json({
      sessionId: session.id,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.promptTokens + usage.completionTokens,
      byMessage: usage.byMessage,
    });
  }

  patch(req: Request, res: Response): void {
    const params = SessionIdParamSchema.safeParse(req.params);
    if (!params.success) throw new AppError('VALIDATION_ERROR', 'sessionId 不合法', 400);
    const parsed = PatchSessionSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', '至少提供一个字段：title / provider / model', 400);
    const session = this.sessions.get(params.data.id);
    if (!session) throw new AppError('SESSION_NOT_FOUND', '会话不存在或已被删除', 404);
    this.assertOwned(session, req);
    const updated = this.sessions.patch(params.data.id, parsed.data);
    if (!updated) throw new AppError('SESSION_NOT_FOUND', '会话不存在或已被删除', 404);
    if (parsed.data.model !== undefined) {
      // Model switch triggers a capability probe (architecture 5.5 trigger 1).
      void this.channelRouter.probe(session.provider, session.model, '', '').catch(() => undefined);
    }
    res.json({ session: publicSession(session) });
  }

  remove(req: Request, res: Response): void {
    const params = SessionIdParamSchema.safeParse(req.params);
    if (!params.success) throw new AppError('VALIDATION_ERROR', 'sessionId 不合法', 400);
    const session = this.sessions.get(params.data.id);
    if (!session) throw new AppError('SESSION_NOT_FOUND', '会话不存在或已被删除', 404);
    this.assertOwned(session, req);
    const deleted = this.sessions.remove(params.data.id);
    if (!deleted) throw new AppError('SESSION_NOT_FOUND', '会话不存在或已被删除', 404);
    res.json({ deleted: true, id: params.data.id });
  }
}
