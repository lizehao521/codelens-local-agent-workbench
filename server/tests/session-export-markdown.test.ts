/**
 * P1-2 会话执行记录 Markdown 导出：渲染安全（反引号注入 / 截断 / 文件名注入 /
 * 坏 JSON 容错）+ 端点行为（404 / 400 / 设备越权 403 / 正确的 Content 头与正文）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { SessionRepository } from '../src/services/memory/session.repository.js';
import { MessageRepository } from '../src/services/memory/message.repository.js';
import { ToolCallRepository } from '../src/services/memory/tool-call.repository.js';
import { SessionsController } from '../src/controllers/sessions.controller.js';
import {
  MAX_BLOCK_CHARS,
  MAX_DOC_CHARS,
  exportFilename,
  fenceFor,
  fencedBlock,
  renderSessionMarkdown,
  safeParseJson,
  sanitizeFilenamePart,
  truncateBlock,
} from '../src/services/export/markdown-export.service.js';
import { sha256Hex } from '../src/utils/hash.js';

const dirs: string[] = [];

function makeHarness() {
  const dir = mkdtempSync(path.join(tmpdir(), 'codelens-export-'));
  dirs.push(dir);
  const db: Db = createDb(path.join(dir, 'agent.db'));
  db.exec(SCHEMA_SQL);
  const sessions = new SessionRepository(db);
  const messages = new MessageRepository(db);
  const toolCalls = new ToolCallRepository(db);
  const controller = new SessionsController(
    sessions,
    messages,
    toolCalls,
    {} as never, // approvals — export path never touches it
    {} as never, // recovery
    { invalidate: () => undefined } as never, // channelRouter
  );
  return { db, sessions, messages, toolCalls, controller };
}

function makeReqRes(params: Record<string, string>, deviceToken?: string) {
  const headers: Record<string, string> = {};
  if (deviceToken) headers['x-device-token'] = deviceToken;
  const req = {
    params,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  let statusCode = 200;
  const headersOut: Record<string, string> = {};
  let sent: string | undefined;
  const res = {
    status(code: number) { statusCode = code; return this; },
    setHeader(name: string, value: string) { headersOut[name.toLowerCase()] = value; return this; },
    send(body: string) { sent = body; return this; },
    json(body: unknown) { sent = JSON.stringify(body); return this; },
  } as unknown as Response;
  return { req, res, status: () => statusCode, headers: headersOut, body: () => sent };
}

afterEach(() => {
  try {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  } catch { /* best-effort cleanup */ }
});

describe('markdown-export.service 纯函数安全', () => {
  it('safeParseJson 对损坏 JSON 返回 null 而不是抛出', () => {
    expect(safeParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(safeParseJson('{broken')).toBeNull();
    expect(safeParseJson(null)).toBeNull();
    expect(safeParseJson('')).toBeNull();
  });

  it('fenceFor 返回比内容中最长反引号串更长的围栏，``` 注入无法提前闭合', () => {
    expect(fenceFor('plain')).toBe('```');
    expect(fenceFor('has ``` inside')).toBe('````');
    expect(fenceFor('has ```` inside')).toBe('`````');
    const evil = 'line1\n```\nline2\n````js\ncode\n```';
    const block = fencedBlock(evil, 'js');
    // 围栏行必须严格长于内容中任何反引号行
    const fence = fenceFor(evil);
    expect(block.startsWith(fence + 'js\n')).toBe(true);
    expect(block.endsWith('\n' + fence)).toBe(true);
    // 内容里的 ``` 行不会被当作闭合围栏（闭合围栏必须整行且与 fence 等长）
    const innerLines = block.split('\n').slice(1, -1);
    expect(innerLines.some((l) => l === fence)).toBe(false);
  });

  it('truncateBlock 超限追加可见截断标记', () => {
    const long = 'x'.repeat(MAX_BLOCK_CHARS + 100);
    const out = truncateBlock(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out.endsWith('…[已截断]')).toBe(true);
    expect(truncateBlock('short')).toBe('short');
  });

  it('sanitizeFilenamePart 剥离路径分隔符/保留字符/控制字符，空则回退 session', () => {
    expect(sanitizeFilenamePart('../../etc/passwd')).not.toMatch(/[/\\]/);
    expect(sanitizeFilenamePart('a/b\\c:d*e?f"g<h>i|j')).not.toMatch(/[\\/:*?"<>|]/);
    // eslint-disable-next-line no-control-regex
    expect(sanitizeFilenamePart('evil\x00\x1f name')).not.toMatch(/[\x00-\x1f]/);
    expect(sanitizeFilenamePart('   ')).toBe('session');
    expect(sanitizeFilenamePart('正常标题.md')).toBe('正常标题.md');
  });

  it('exportFilename 由标题派生且不含路径注入字符', () => {
    const session = { title: '../evil/标题', id: 'x' } as never;
    const name = exportFilename(session, new Date('2026-01-02T03:04:05Z'));
    expect(name).toMatch(/^codelens-.*-2026-01-02-03-04-05\.md$/);
    expect(name).not.toMatch(/[/\\]/);
  });
});

describe('renderSessionMarkdown 文档结构', () => {
  it('渲染消息时间线 + 工具调用，坏 JSON 降级不抛错', () => {
    const { db, sessions, messages, toolCalls } = makeHarness();
    const session = sessions.create({ provider: 'p', model: 'm', title: '导出测试' });
    messages.insert({ sessionId: session.id, role: 'user', content: '你好 ``` 注入' });
    messages.insert({
      sessionId: session.id,
      role: 'assistant',
      content: '回复内容',
      toolCallsJson: JSON.stringify([{ id: 'call-1', function: { name: 'fs.read', arguments: '{"path":"a.ts"}' } }]),
    });
    messages.insert({ sessionId: session.id, role: 'tool', content: '文件内容', toolCallId: 'call-1' });
    // 损坏的 JSON 字段
    messages.insert({ sessionId: session.id, role: 'assistant', content: '坏段', segmentsJson: '{oops' });
    const call = toolCalls.insert({
      sessionId: session.id,
      messageId: null,
      callId: 'call-1',
      toolName: 'fs.read',
      toolWireName: 'fs_read',
      displayName: '读取文件',
      category: 'fs',
      source: 'builtin',
      risk: 'low',
      approvalMode: 'none',
      channel: 'native',
      iteration: 1,
      argsJson: '{"path":"a.ts"}',
      argsDigest: 'd',
    });
    toolCalls.markFinished(call.id, { status: 'success', resultSummary: '读取成功 10 行' });

    const doc = renderSessionMarkdown({
      session,
      messages: messages.listBySession(session.id),
      toolCalls: toolCalls.listBySession(session.id),
    });
    expect(doc).toContain('# 会话导出: 导出测试');
    expect(doc).toContain('### 用户 · #1');
    expect(doc).toContain('### 助手 · #2');
    expect(doc).toContain('**工具调用:**');
    expect(doc).toContain('`fs.read`');
    expect(doc).toContain('call-1');
    expect(doc).toContain('读取成功 10 行');
    // 注入内容被更长围栏包裹，文档内不存在裸的三反引号闭合
    expect(doc).toContain('````');
    db.close();
  });

  it('整篇文档超过 MAX_DOC_CHARS 时截断并带标记', () => {
    const { db, sessions, messages } = makeHarness();
    const session = sessions.create({ provider: 'p', model: 'm', title: '大文档' });
    for (let i = 0; i < 40; i++) {
      messages.insert({ sessionId: session.id, role: 'user', content: '长内容'.repeat(2000) });
    }
    const doc = renderSessionMarkdown({
      session,
      messages: messages.listBySession(session.id),
      toolCalls: [],
    });
    expect(doc.length).toBeLessThanOrEqual(MAX_DOC_CHARS + 100);
    expect(doc).toContain('已截断');
    db.close();
  });
});

describe('SessionsController.exportMarkdown 端点', () => {
  it('返回 text/markdown 附件，含 RFC5987 双文件名，正文为渲染结果', () => {
    const { db, sessions, messages, controller } = makeHarness();
    const deviceToken = 'dt_testtoken123';
    const session = sessions.create({
      provider: 'p', model: 'm', title: '端点测试', deviceTokenHash: sha256Hex(deviceToken),
    });
    messages.insert({ sessionId: session.id, role: 'user', content: 'hello' });
    const { req, res, status, headers, body } = makeReqRes({ id: session.id }, deviceToken);
    controller.exportMarkdown(req, res);
    expect(status()).toBe(200);
    expect(headers['content-type']).toContain('text/markdown');
    expect(headers['content-disposition']).toContain('attachment;');
    expect(headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(body()).toContain('# 会话导出: 端点测试');
    expect(body()).toContain('hello');
    db.close();
  });

  it('会话不存在返回 404 SESSION_NOT_FOUND', () => {
    const { db, controller } = makeHarness();
    const { req, res } = makeReqRes({ id: crypto.randomUUID() });
    expect(() => controller.exportMarkdown(req, res)).toThrowError(/会话不存在/);
    db.close();
  });

  it('sessionId 非法返回 400 VALIDATION_ERROR', () => {
    const { db, controller } = makeHarness();
    const { req, res } = makeReqRes({ id: 'not-a-uuid' });
    expect(() => controller.exportMarkdown(req, res)).toThrowError(/sessionId 不合法/);
    db.close();
  });

  it('设备令牌不匹配返回 403（AUDIT-018 越权拦截）', () => {
    const { db, sessions, controller } = makeHarness();
    const session = sessions.create({
      provider: 'p', model: 'm', title: '他人会话', deviceTokenHash: sha256Hex('owner-token'),
    });
    const { req, res } = makeReqRes({ id: session.id }, 'wrong-token');
    expect(() => controller.exportMarkdown(req, res)).toThrowError(/无权访问/);
    // 无设备头同样拒绝
    const { req: req2, res: res2 } = makeReqRes({ id: session.id });
    expect(() => controller.exportMarkdown(req2, res2)).toThrowError(/无权访问/);
    db.close();
  });
});
