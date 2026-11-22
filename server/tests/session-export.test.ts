/**
 * P1-2 · 会话执行记录导出 Markdown。
 *
 * 覆盖两层：
 *  A. 纯渲染（renderSessionMarkdown / exportFilename）：结构、围栏自适应、截断、
 *     未归属工具调用、统计口径、文件名不含 title（防 header 注入）；
 *  B. HTTP 端点 GET /api/v1/sessions/:id/export.md：200 + 附件头 + 正文关键段、
 *     404 不存在、400 非法 id、403 越权（设备令牌不匹配）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../src/app.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { createDb } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { SessionRepository } from '../src/services/memory/session.repository.js';
import { MessageRepository } from '../src/services/memory/message.repository.js';
import { ToolCallRepository } from '../src/services/memory/tool-call.repository.js';
import {
  exportFilename,
  renderSessionMarkdown,
  EXPORT_RESULT_SUMMARY_MAX,
  type SessionExportData,
} from '../src/services/export/session-markdown.js';
import { sha256Hex } from '../src/utils/hash.js';

function makeData(overrides: Partial<SessionExportData> = {}): SessionExportData {
  const db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  const session = new SessionRepository(db).create({ provider: 'openai', model: 'gpt-x', title: '导出测试会话' });
  return {
    session,
    messages: [],
    toolCalls: [],
    ...overrides,
  };
}

describe('renderSessionMarkdown（纯渲染）', () => {
  it('渲染头部元信息 + 空消息占位 + 统计', () => {
    const data = makeData();
    const md = renderSessionMarkdown(data);
    expect(md).toContain('# 导出测试会话');
    expect(md).toContain(`- 会话 ID：\`${data.session.id}\``);
    expect(md).toContain('- Provider / Model：openai / gpt-x');
    expect(md).toContain('（本会话暂无消息）');
    expect(md).toContain('- 消息：0 条');
    expect(md).toContain('- 工具调用：0 次');
  });

  it('消息按 seq 渲染，工具调用归属到所属消息，含状态/耗时/参数/结果', () => {
    const db = createDb(':memory:');
    db.exec(SCHEMA_SQL);
    const sessions = new SessionRepository(db);
    const messages = new MessageRepository(db);
    const toolCalls = new ToolCallRepository(db);
    const session = sessions.create({ provider: 'p', model: 'm', title: 't' });
    const userMsg = messages.insert({ sessionId: session.id, role: 'user', content: '帮我算 1+1' });
    const asstMsg = messages.insert({ sessionId: session.id, role: 'assistant', content: '结果是 2' });
    const call = toolCalls.insert({
      sessionId: session.id,
      messageId: asstMsg.id,
      callId: 'call_1',
      toolName: 'calc.evaluate',
      toolWireName: 'calc_evaluate',
      displayName: '计算',
      category: 'compute',
      source: 'builtin',
      risk: 'low',
      approvalMode: 'none',
      channel: 'native',
      iteration: 1,
      argsJson: JSON.stringify({ expression: '1+1' }),
      argsDigest: 'd',
    });
    toolCalls.markRunning(call.id);
    toolCalls.markFinished(call.id, { status: 'success', resultSummary: '2', truncated: false });

    const md = renderSessionMarkdown({
      session,
      messages: messages.listBySession(session.id),
      toolCalls: toolCalls.listBySession(session.id),
    });
    expect(md).toContain('### 1. 用户');
    expect(md).toContain('### 2. 助手');
    expect(md).toContain('#### 工具调用 `calc.evaluate` — 成功');
    expect(md).toContain('"expression": "1+1"');
    expect(md).toContain('结果摘要：');
    expect(md).toContain('- 工具调用：1 次（成功 1）');
    void userMsg;
  });

  it('内容里的 ``` 不会提前闭合围栏（自适应围栏长度）', () => {
    const db = createDb(':memory:');
    db.exec(SCHEMA_SQL);
    const sessions = new SessionRepository(db);
    const messages = new MessageRepository(db);
    const session = sessions.create({ provider: 'p', model: 'm' });
    messages.insert({ sessionId: session.id, role: 'user', content: '看这段 ```js\ncode\n``` 怎么样' });
    const md = renderSessionMarkdown({ session, messages: messages.listBySession(session.id), toolCalls: [] });
    // 围栏必须比内容里最长反引号串长
    expect(md).toContain('````js\n看这段 ```js\ncode\n``` 怎么样\n````');
  });

  it('超长结果摘要被截断并带标记；损坏的 args_json 原样进围栏而不抛错', () => {
    const db = createDb(':memory:');
    db.exec(SCHEMA_SQL);
    const sessions = new SessionRepository(db);
    const toolCalls = new ToolCallRepository(db);
    const session = sessions.create({ provider: 'p', model: 'm' });
    const call = toolCalls.insert({
      sessionId: session.id,
      messageId: null,
      callId: 'call_bad',
      toolName: 'fs.read',
      toolWireName: 'fs_read',
      displayName: '读文件',
      category: 'file',
      source: 'builtin',
      risk: 'low',
      approvalMode: 'none',
      channel: 'native',
      iteration: 0,
      argsJson: '{not valid json',
      argsDigest: 'd',
    });
    toolCalls.markFinished(call.id, {
      status: 'success',
      resultSummary: 'x'.repeat(EXPORT_RESULT_SUMMARY_MAX + 100),
      truncated: true,
    });
    const md = renderSessionMarkdown({ session, messages: [], toolCalls: toolCalls.listBySession(session.id) });
    expect(md).toContain('## 未归属消息的工具调用');
    expect(md).toContain('已截断');
    expect(md).toContain('{not valid json');
    expect(md).toContain('结果摘要（已截断）：');
  });

  it('exportFilename 只含 session id 前缀 + 时间戳，不含 title（防 Content-Disposition 注入）', () => {
    const db = createDb(':memory:');
    db.exec(SCHEMA_SQL);
    const session = new SessionRepository(db).create({ provider: 'p', model: 'm', title: '邪恶"标题\r\nX-Inject: 1' });
    const name = exportFilename(session, Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(name).toBe(`codelens-session-${session.id.slice(0, 8)}-20260102-030405.md`);
    expect(name).not.toContain('邪恶');
    expect(name).not.toMatch(/[\r\n"]/);
  });
});

describe('GET /api/v1/sessions/:id/export.md（HTTP 端点）', () => {
  let runtime: Runtime;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'codelens-export-'));
    runtime = createRuntime({ dbPath: path.join(tmpRoot, 'export.db') });
  });

  afterEach(async () => {
    await runtime.close();
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort 清理
    }
  });

  function seedSession(deviceTokenHash: string | null = null) {
    const session = runtime.db
      ? new SessionRepository(runtime.db).create({ provider: 'openai', model: 'gpt-x', title: '端点测试', deviceTokenHash })
      : null;
    if (!session) throw new Error('unreachable');
    const messages = new MessageRepository(runtime.db);
    const toolCalls = new ToolCallRepository(runtime.db);
    messages.insert({ sessionId: session.id, role: 'user', content: '你好' });
    const asst = messages.insert({ sessionId: session.id, role: 'assistant', content: '你好！有什么可以帮你？' });
    const call = toolCalls.insert({
      sessionId: session.id,
      messageId: asst.id,
      callId: 'call_e2e',
      toolName: 'time.now',
      toolWireName: 'time_now',
      displayName: '时间',
      category: 'compute',
      source: 'builtin',
      risk: 'low',
      approvalMode: 'none',
      channel: 'native',
      iteration: 1,
      argsJson: '{}',
      argsDigest: 'd',
    });
    toolCalls.markRunning(call.id);
    toolCalls.markFinished(call.id, { status: 'success', resultSummary: '2026-01-01T00:00:00Z' });
    return session;
  }

  it('200 + text/markdown 附件头 + 正文含消息与工具调用', async () => {
    const session = seedSession();
    const app = createApp({ runtime, autoStartModelSync: false });
    const res = await request(app).get(`/api/v1/sessions/${session.id}/export.md`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="codelens-session-[0-9a-f]{8}-\d{8}-\d{6}\.md"$/);
    const text = res.text;
    expect(text).toContain('# 端点测试');
    expect(text).toContain('### 1. 用户');
    expect(text).toContain('你好');
    expect(text).toContain('#### 工具调用 `time.now` — 成功');
    expect(text).toContain('2026-01-01T00:00:00Z');
    expect(text).toContain('## 统计');
  });

  it('不存在的 session 返 404 SESSION_NOT_FOUND', async () => {
    const app = createApp({ runtime, autoStartModelSync: false });
    const res = await request(app).get(`/api/v1/sessions/${crypto.randomUUID()}/export.md`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('非法 sessionId 返 400 VALIDATION_ERROR', async () => {
    const app = createApp({ runtime, autoStartModelSync: false });
    const res = await request(app).get('/api/v1/sessions/not-a-uuid/export.md');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('绑定设备令牌的会话，错误令牌返 403（与 detail 同口径）', async () => {
    const session = seedSession(sha256Hex('correct-token'));
    const app = createApp({ runtime, autoStartModelSync: false });
    const denied = await request(app)
      .get(`/api/v1/sessions/${session.id}/export.md`)
      .set('X-Device-Token', 'wrong-token');
    expect(denied.status).toBe(403);
    const ok = await request(app)
      .get(`/api/v1/sessions/${session.id}/export.md`)
      .set('X-Device-Token', 'correct-token');
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('# 端点测试');
  });
});
