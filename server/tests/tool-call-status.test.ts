/**
 * B1 (判据塔自证缺口关闭): `tool_calls` 表的 DDL CHECK 枚举约束必须有运行时破坏夹具。
 *
 * 破坏夹具性质: 这些用例断言「非法枚举值会被 SQLite 拒绝」。若有人删除/削弱
 * schema.ts 里的 CHECK(status IN (...)) 或 CHECK(category IN (...))，下面的 toThrow
 * 就会变红 —— 即判据不是永真闸。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { ToolCallRepository, type InsertToolCallInput } from '../src/services/memory/tool-call.repository.js';

function validInput(overrides: Partial<InsertToolCallInput> = {}): InsertToolCallInput {
  return {
    sessionId: 's1',
    messageId: null,
    callId: 'c1',
    toolName: 'fs.read',
    toolWireName: 'fs_read',
    displayName: '读取文件',
    category: 'file',
    source: 'builtin',
    risk: 'low',
    approvalMode: 'none',
    channel: 'native',
    iteration: 0,
    argsJson: '{}',
    argsDigest: 'd1',
    ...overrides,
  };
}

/** 25 列必须与 schema.ts 中 tool_calls 定义顺序完全一致。 */
const INSERT_COLUMNS = `id, session_id, message_id, call_id, tool_name, tool_wire_name, display_name,
  category, source, risk, approval_mode, channel, iteration, args_json, args_digest,
  status, error_kind, error_msg, result_ref, result_summary, truncated,
  started_at, ended_at, duration_ms, created_at`;
const PLACEHOLDERS = `?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, NULL, NULL, 0, ?`;

describe('tool_calls DDL CHECK 枚举约束 (judge 自证 B1)', () => {
  let db: Db;
  let repo: ToolCallRepository;

  beforeEach(() => {
    db = createDb(':memory:');
    db.exec(SCHEMA_SQL);
    // tool_calls.session_id 有外键指向 sessions，先建一条满足约束的 session。
    db.run(
      `INSERT INTO sessions (id, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ['s1', 'openai', 'gpt-4o-mini', Date.now(), Date.now()],
    );
    repo = new ToolCallRepository(db);
  });

  it('repository insert 合法枚举 status 成功落库', () => {
    const row = repo.insert(validInput());
    expect(row.status).toBe('pending');
    expect(repo.get(row.id)?.status).toBe('pending');
  });

  it('DDL CHECK 拒绝非法 status 枚举 (改坏 CHECK 必红)', () => {
    expect(() =>
      db.run(
        `INSERT INTO tool_calls (${INSERT_COLUMNS}) VALUES (${PLACEHOLDERS})`,
        ['bad-1', 's1', null, 'c2', 'fs.read', 'fs_read', '读取文件', 'file', 'builtin', 'low', 'none', 'native', 0, '{}', 'd2', 'BOGUS', Date.now()],
      ),
    ).toThrow();
  });

  it('DDL CHECK 拒绝非法 category 枚举 (改坏 CHECK 必红)', () => {
    expect(() =>
      db.run(
        `INSERT INTO tool_calls (${INSERT_COLUMNS}) VALUES (${PLACEHOLDERS})`,
        ['bad-2', 's1', null, 'c3', 'fs.read', 'fs_read', '读取文件', 'BOGUS', 'builtin', 'low', 'none', 'native', 0, '{}', 'd3', 'pending', Date.now()],
      ),
    ).toThrow();
  });

  it('markFinished 合法终态 status 通过 CHECK', () => {
    const row = repo.insert(validInput());
    repo.markFinished(row.id, { status: 'success' });
    expect(repo.get(row.id)?.status).toBe('success');
  });
});
