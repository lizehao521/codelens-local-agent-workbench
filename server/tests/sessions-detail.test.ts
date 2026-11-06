/**
 * Sessions detail projection (P1-6) — the audit chain a refreshed client rebuilds from.
 *
 * GET /api/v1/sessions/:id has always returned `toolCalls`, but the rows lacked
 * the two fields the client needs to re-attach them to messages and to render
 * failures truthfully: `messageId` (which assistant message owns the call) and
 * `errorMessage` (the server-side error text). This suite pins the projection:
 *   1. every audit row carries messageId / errorKind / errorMessage
 *   2. message segments round-trip so tool segments still resolve after refresh
 *   3. unknown session → 404 SESSION_NOT_FOUND
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { SessionRepository } from '../src/services/memory/session.repository.js';
import { MessageRepository } from '../src/services/memory/message.repository.js';
import { ToolCallRepository } from '../src/services/memory/tool-call.repository.js';
import { ApprovalRepository } from '../src/services/memory/approval.repository.js';
import { ProviderCapabilityRepository } from '../src/services/memory/provider-capability.repository.js';
import { RecoveryService } from '../src/services/recovery.service.js';
import { OpenAICompatibleAdapter } from '../src/providers/openai-compatible.adapter.js';
import { ChannelRouter } from '../src/services/agent/channel-router.service.js';
import { SessionsController } from '../src/controllers/sessions.controller.js';

let dir: string;
let db: Db;
let controller: SessionsController;
let sessions: SessionRepository;
let messages: MessageRepository;
let toolCalls: ToolCallRepository;
let sessionId: string;
let assistantId: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'codelens-sessions-detail-'));
  db = createDb(path.join(dir, 'detail.db'));
  db.exec(SCHEMA_SQL);
  sessions = new SessionRepository(db);
  messages = new MessageRepository(db);
  toolCalls = new ToolCallRepository(db);
  const approvals = new ApprovalRepository(db);
  const capabilities = new ProviderCapabilityRepository(db);
  const router = new ChannelRouter(new OpenAICompatibleAdapter(), capabilities);
  controller = new SessionsController(
    sessions,
    messages,
    toolCalls,
    approvals,
    new RecoveryService(sessions),
    router,
  );

  sessionId = sessions.create({ provider: 'openai', model: 'gpt-4o-mini' })!.id;
  messages.insert({
    sessionId,
    role: 'user',
    content: '读一下文件',
    segmentsJson: JSON.stringify([{ type: 'text', text: '读一下文件' }]),
  });
  const assistant = messages.insert({
    sessionId,
    role: 'assistant',
    content: '',
    segmentsJson: JSON.stringify([
      { type: 'text', text: '我来读取' },
      { type: 'tool', callId: 'c1' },
      { type: 'tool', callId: 'c2' },
    ]),
  });
  assistantId = assistant.id;

  const ok = toolCalls.insert({
    sessionId,
    messageId: assistantId,
    callId: 'c1',
    toolName: 'fs.read',
    toolWireName: 'fs_read',
    displayName: '读取文件',
    category: 'file',
    source: 'builtin',
    risk: 'medium',
    approvalMode: 'none',
    channel: 'native',
    iteration: 1,
    argsJson: JSON.stringify({ path: 'data/a.txt' }),
    argsDigest: 'd1',
  });
  toolCalls.markFinished(ok.id, { status: 'success', resultRef: 'res_1', resultSummary: '读取成功：12 行' });

  const bad = toolCalls.insert({
    sessionId,
    messageId: assistantId,
    callId: 'c2',
    toolName: 'http.request',
    toolWireName: 'http_request',
    displayName: 'HTTP 请求',
    category: 'http',
    source: 'builtin',
    risk: 'high',
    approvalMode: 'hard',
    channel: 'native',
    iteration: 1,
    argsJson: JSON.stringify({ url: 'https://evil.example.com' }),
    argsDigest: 'd2',
  });
  toolCalls.markFinished(bad.id, {
    status: 'failed',
    errorKind: 'security',
    errorMsg: '主机不在白名单',
    resultRef: 'res_2',
    resultSummary: '请求被安全策略拒绝',
  });
});

afterEach(() => {
  db.close();
  // 宿主环境的删除守卫（safe-delete shim）可能在并发下超时。
  // 清理是 best-effort：残留目录由环境侧回收，但不能让它把已通过的用例判红。
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
  }
});

interface DetailBody {
  session: { id: string };
  messages: Array<{ id: string; segments: Array<{ type: string; callId?: string }> | null }>;
  toolCalls: Array<Record<string, unknown>>;
  approvals: unknown[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

function callDetail(id: string): DetailBody {
  let payload: DetailBody | undefined;
  const req = { params: { id } } as unknown as Request;
  const res = { json: (body: unknown) => { payload = body as DetailBody; } } as unknown as Response;
  controller.detail(req, res);
  if (!payload) throw new Error('detail did not respond');
  return payload;
}

describe('SessionsController.detail 工具审计投影（P1-6）', () => {
  it('每行都带 messageId / errorKind / errorMessage（前端水合的必需字段）', () => {
    const body = callDetail(sessionId);
    expect(body.toolCalls).toHaveLength(2);

    const c1 = body.toolCalls.find((r) => r.callId === 'c1')!;
    expect(c1.messageId).toBe(assistantId);
    expect(c1.status).toBe('success');
    expect(c1.resultSummary).toBe('读取成功：12 行');
    expect(c1.errorKind).toBeNull();
    expect(c1.errorMessage).toBeNull();
    expect(typeof c1.durationMs).toBe('number');

    const c2 = body.toolCalls.find((r) => r.callId === 'c2')!;
    expect(c2.messageId).toBe(assistantId);
    expect(c2.status).toBe('failed');
    expect(c2.errorKind).toBe('security');
    expect(c2.errorMessage).toBe('主机不在白名单');
  });

  it('消息 segments 原样往返，tool 段引用的 callId 与水合行一致', () => {
    const body = callDetail(sessionId);
    const assistant = body.messages.find((m) => m.id === assistantId)!;
    const toolCallIds = (assistant.segments ?? [])
      .filter((s) => s.type === 'tool')
      .map((s) => s.callId);
    expect(toolCallIds).toEqual(['c1', 'c2']);
    expect(body.toolCalls.map((r) => r.callId)).toEqual(toolCallIds);
  });

  it('未知会话 → SESSION_NOT_FOUND 404', () => {
    // 合法 UUID 格式但库里不存在（格式非法会先被 400 拦，走不到 404 分支）
    expect(() => callDetail('00000000-0000-4000-8000-000000000000')).toThrowError(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND', status: 404 }),
    );
  });
});

interface UsageBody {
  sessionId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  byMessage: Array<{ id: string; seq: number; role: string; promptTokens: number; completionTokens: number }>;
}

function callUsage(id: string): UsageBody {
  let payload: UsageBody | undefined;
  const req = { params: { id } } as unknown as Request;
  const res = { json: (body: unknown) => { payload = body as UsageBody; } } as unknown as Response;
  controller.usage(req, res);
  if (!payload) throw new Error('usage did not respond');
  return payload;
}

describe('Sessions 对账 usage（AUDIT-028）', () => {
  it('聚合 messages.usage_json 的精确 prompt/completion 总量与明细', () => {
    messages.finalize(assistantId, { usageJson: JSON.stringify({ promptTokens: 100, completionTokens: 50 }) });
    messages.insert({
      sessionId,
      role: 'assistant',
      content: '第二轮',
      usageJson: JSON.stringify({ promptTokens: 30, completionTokens: 20 }),
    });
    const body = callUsage(sessionId);
    expect(body.promptTokens).toBe(130);
    expect(body.completionTokens).toBe(70);
    expect(body.totalTokens).toBe(200);
    // user 无 usage → 0，外加两个 assistant
    expect(body.byMessage).toHaveLength(3);
    expect(body.byMessage.some((m) => m.promptTokens === 100 && m.completionTokens === 50)).toBe(true);
  });

  it('损坏的 usage_json 按 0 计、不抛错', () => {
    messages.insert({ sessionId, role: 'assistant', content: '坏 JSON', usageJson: 'not-json{' });
    const body = callUsage(sessionId);
    expect(body.totalTokens).toBe(0);
    expect(body.byMessage.some((m) => m.promptTokens === 0 && m.completionTokens === 0)).toBe(true);
  });

  it('detail 投影同时返回精确 usage 总量', () => {
    messages.finalize(assistantId, { usageJson: JSON.stringify({ promptTokens: 40, completionTokens: 5 }) });
    const body = callDetail(sessionId) as DetailBody & {
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    };
    expect(body.usage).toEqual({ promptTokens: 40, completionTokens: 5, totalTokens: 45 });
  });

  it('未知会话 → SESSION_NOT_FOUND 404', () => {
    expect(() => callUsage('00000000-0000-4000-8000-000000000000')).toThrowError(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND', status: 404 }),
    );
  });
});
