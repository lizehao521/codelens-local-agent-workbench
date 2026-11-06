/**
 * SessionsController 访问控制（AUDIT-018）与详情容错（AUDIT-017）。
 *
 * AUDIT-018：detail / patch / remove 必须校验会话绑定的设备令牌；同实例上其他
 * 设备（或匿名）不能列举/修改/删除他人会话。已绑定会话在无 X-Device-Token 或
 * 令牌不匹配时返回 403 SESSION_ACCESS_DENIED；历史空哈希（早于设备机制）放行。
 *
 * AUDIT-017：detail 投影中 segments_json / args_json 损坏时返回 null 而非整条 500。
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
import { sha256Hex } from '../src/utils/hash.js';

const DEVICE_A = sha256Hex('device-A-secret');
const DEVICE_B = sha256Hex('device-B-secret');

let dir: string;
let db: Db;
let controller: SessionsController;
let sessions: SessionRepository;
let messages: MessageRepository;
let toolCalls: ToolCallRepository;
let legacyId: string;
let ownedId: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'codelens-sessions-access-'));
  db = createDb(path.join(dir, 'access.db'));
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

  // 无设备绑定的历史会话（device_token_hash 为空）——兼容旧数据，应放行。
  legacyId = sessions.create({ provider: 'openai', model: 'gpt-4o-mini' }).id;
  // 绑定到设备 A 的会话，并植入损坏的 JSON（AUDIT-017 用例）。
  ownedId = sessions.create({ provider: 'openai', model: 'gpt-4o-mini', deviceTokenHash: DEVICE_A }).id;
  const ownedMsg = messages.insert({ sessionId: ownedId, role: 'user', content: 'hi', segmentsJson: 'not-json{' });
  toolCalls.insert({
    sessionId: ownedId,
    messageId: ownedMsg.id,
    callId: 'c1',
    toolName: 'fs.read',
    toolWireName: 'fs_read',
    displayName: '读取文件',
    category: 'file',
    source: 'builtin',
    risk: 'low',
    approvalMode: 'none',
    channel: 'native',
    iteration: 1,
    argsJson: 'not-json{',
    argsDigest: 'd',
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

function reqWith(id: string, deviceToken?: string, body?: unknown): Request {
  return {
    params: { id },
    body,
    header: (name: string) => (name === 'X-Device-Token' ? deviceToken : undefined),
  } as unknown as Request;
}

function listReqWith(deviceToken?: string): Request {
  return {
    query: {},
    header: (name: string) => (name === 'X-Device-Token' ? deviceToken : undefined),
  } as unknown as Request;
}

function resJson(): { res: Response; take: () => unknown } {
  let payload: unknown;
  const res = { json: (body: unknown) => { payload = body; } } as unknown as Response;
  return { res, take: () => payload };
}

describe('AUDIT-018 会话设备归属校验', () => {
  it('绑定会话 + 正确设备令牌 → 200', () => {
    const { res, take } = resJson();
    expect(() => controller.detail(reqWith(ownedId, 'device-A-secret'), res)).not.toThrow();
    expect(take()).toBeDefined();
  });

  it('绑定会话 + 错误设备令牌 → 403 SESSION_ACCESS_DENIED', () => {
    const { res } = resJson();
    expect(() => controller.detail(reqWith(ownedId, 'device-B-secret'), res)).toThrowError(
      expect.objectContaining({ code: 'SESSION_ACCESS_DENIED', status: 403 }),
    );
  });

  it('绑定会话 + 无令牌头 → 403（不能匿名访问他人会话）', () => {
    const { res } = resJson();
    expect(() => controller.detail(reqWith(ownedId), res)).toThrowError(
      expect.objectContaining({ code: 'SESSION_ACCESS_DENIED', status: 403 }),
    );
  });

  it('历史空哈希会话（无设备绑定）→ 任何/无令牌均放行（兼容旧数据）', () => {
    const { res } = resJson();
    expect(() => controller.detail(reqWith(legacyId), res)).not.toThrow();
    expect(() => controller.detail(reqWith(legacyId, 'device-A-secret'), res)).not.toThrow();
  });

  it('patch：错误设备令牌 → 403；正确令牌 → 200', () => {
    const bad = resJson();
    expect(() => controller.patch(reqWith(ownedId, 'device-B-secret', { title: 'x' }), bad.res)).toThrowError(
      expect.objectContaining({ code: 'SESSION_ACCESS_DENIED', status: 403 }),
    );
    const ok = resJson();
    expect(() => controller.patch(reqWith(ownedId, 'device-A-secret', { title: 'x' }), ok.res)).not.toThrow();
  });

  it('remove：正确令牌删除成功；错误令牌 403 且数据不丢', () => {
    const bad = resJson();
    expect(() => controller.remove(reqWith(ownedId, 'device-B-secret'), bad.res)).toThrowError(
      expect.objectContaining({ code: 'SESSION_ACCESS_DENIED', status: 403 }),
    );
    // 错误令牌未删除：仍可被正确令牌取到
    const ok = resJson();
    expect(() => controller.detail(reqWith(ownedId, 'device-A-secret'), ok.res)).not.toThrow();

    const del = resJson();
    expect(() => controller.remove(reqWith(ownedId, 'device-A-secret'), del.res)).not.toThrow();
    const after = resJson();
    expect(() => controller.detail(reqWith(ownedId, 'device-A-secret'), after.res)).toThrowError(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND', status: 404 }),
    );
  });
});

describe('AUDIT-018 会话列表越权（LIST fail-closed）', () => {
  it('无 X-Device-Token → 空列表，不泄露他人会话', () => {
    const { res, take } = resJson();
    controller.list(listReqWith(), res);
    const body = take() as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('正确设备令牌 → 仅返回该设备自己的会话', () => {
    const { res, take } = resJson();
    controller.list(listReqWith('device-A-secret'), res);
    const body = take() as { items: Array<{ id: string }>; total: number };
    expect(body.items.map((s) => s.id)).toEqual([ownedId]);
    expect(body.total).toBe(1);
  });

  it('错误设备令牌 → 空列表，不泄露设备 A 的会话', () => {
    const { res, take } = resJson();
    controller.list(listReqWith('device-B-secret'), res);
    const body = take() as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });
});

describe('AUDIT-017 详情容错（损坏 JSON 不 500）', () => {
  it('segments_json / args_json 损坏 → 返回 null 而非整条 500', () => {
    const { res, take } = resJson();
    expect(() => controller.detail(reqWith(ownedId, 'device-A-secret'), res)).not.toThrow();
    const body = take() as { messages: Array<{ segments: unknown }>; toolCalls: Array<{ arguments: unknown }> };
    expect(body.messages[0].segments).toBeNull();
    expect(body.toolCalls[0].arguments).toBeNull();
  });

  it('合法 JSON 仍原样往返（非回归）', () => {
    const okId = sessions.create({ provider: 'openai', model: 'gpt-4o-mini', deviceTokenHash: DEVICE_A }).id;
    const okMsg = messages.insert({ sessionId: okId, role: 'assistant', content: '', segmentsJson: JSON.stringify([{ type: 'text', text: 'x' }]) });
    toolCalls.insert({
      sessionId: okId,
      messageId: okMsg.id,
      callId: 'c2',
      toolName: 'fs.read',
      toolWireName: 'fs_read',
      displayName: '读',
      category: 'file',
      source: 'builtin',
      risk: 'low',
      approvalMode: 'none',
      channel: 'native',
      iteration: 1,
      argsJson: JSON.stringify({ path: 'a.txt' }),
      argsDigest: 'd2',
    });
    const { res, take } = resJson();
    controller.detail(reqWith(okId, 'device-A-secret'), res);
    const body = take() as { messages: Array<{ segments: unknown }>; toolCalls: Array<{ arguments: unknown }> };
    expect(body.messages[0].segments).toEqual([{ type: 'text', text: 'x' }]);
    expect(body.toolCalls[0].arguments).toEqual({ path: 'a.txt' });
  });
});
