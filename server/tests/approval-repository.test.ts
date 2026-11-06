// approval-repository 单测——write-once 决策与 changes===1 断言（AC-06）
// 架构师实测发现：SQLite 对匹配 0 行的 UPDATE 不报错，changes 静默为 0。
// 每次决策写入都必须断言 changes===1，否则重复决定会变成无声 no-op。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { ApprovalRepository } from '../src/services/memory/approval.repository.js';
import { sha256Hex } from '../src/utils/hash.js';

const SESSION_ID = 'se_test';
const TOOL_CALL_ID = 'tc_test';

let db: Db;
let repo: ApprovalRepository;

function seedFixtures(): void {
  const now = Date.now();
  db.run(
    `INSERT INTO sessions (id, title, provider, model, created_at, updated_at)
     VALUES (?, '测试会话', 'deepseek', 'deepseek-v4-pro', ?, ?)`,
    [SESSION_ID, now, now],
  );
  db.run(
    `INSERT INTO tool_calls (id, session_id, call_id, tool_name, tool_wire_name, display_name,
       category, source, risk, approval_mode, channel, created_at)
     VALUES (?, ?, 'call_001', 'http.request', 'http_request', 'HTTP 请求',
       'http', 'builtin', 'high', 'hard', 'native', ?)`,
    [TOOL_CALL_ID, SESSION_ID, now],
  );
}

function insertApproval(): string {
  return repo.insert({
    sessionId: SESSION_ID,
    toolCallId: TOOL_CALL_ID,
    toolName: 'http.request',
    argsDigest: 'a'.repeat(64),
    challengeTokenHash: sha256Hex('t_fake.token'),
    expiresAt: Date.now() + 300_000,
  }).id;
}

describe('approval-repository', () => {
  beforeEach(() => {
    db = createDb(':memory:');
    db.exec(SCHEMA_SQL);
    repo = new ApprovalRepository(db);
    seedFixtures();
  });
  afterEach(() => {
    db.close();
  });

  it('insert 落库为 pending，decision 为空', () => {
    const row = repo.get(insertApproval())!;
    expect(row.status).toBe('pending');
    expect(row.decision).toBeNull();
    expect(row.mismatch_count).toBe(0);
    expect(row.revise_depth).toBe(0);
  });

  it('首次 decide 成功，行变为 decided', () => {
    const id = insertApproval();
    const row = repo.decide(id, 'allow_once', '用户批准');
    expect(row.status).toBe('decided');
    expect(row.decision).toBe('allow_once');
    expect(row.reason).toBe('用户批准');
    expect(row.decided_at).toBeGreaterThan(0);
  });

  it('重复 decide 抛 APPROVAL_ALREADY_DECIDED（changes===1 断言）', () => {
    const id = insertApproval();
    repo.decide(id, 'allow_once', null);
    expect(() => repo.decide(id, 'reject', '改主意')).toThrow('APPROVAL_ALREADY_DECIDED');
  });

  it('decide 一个不存在的 id 同样抛错（防伪造 id 探测）', () => {
    expect(() => repo.decide('ap_nonexistent', 'allow_once', null)).toThrow(
      'APPROVAL_ALREADY_DECIDED',
    );
  });

  it('revise 后 decide 抛错（换挑战不解决驻留）', () => {
    const id = insertApproval();
    repo.markRevised(id);
    expect(repo.get(id)!.status).toBe('revised');
    expect(() => repo.decide(id, 'allow_once', null)).toThrow('APPROVAL_ALREADY_DECIDED');
  });

  it('重复 markRevised 抛错', () => {
    const id = insertApproval();
    repo.markRevised(id);
    expect(() => repo.markRevised(id)).toThrow('APPROVAL_ALREADY_DECIDED');
  });

  it('revised_from_id / revise_depth 记录修订链', () => {
    const first = repo.insert({
      sessionId: SESSION_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: 'http.request',
      argsDigest: 'a'.repeat(64),
      challengeTokenHash: sha256Hex('t_1'),
      expiresAt: Date.now() + 300_000,
    });
    const revised = repo.insert({
      sessionId: SESSION_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: 'http.request',
      argsDigest: 'b'.repeat(64),
      challengeTokenHash: sha256Hex('t_2'),
      expiresAt: Date.now() + 300_000,
      revisedFromId: first.id,
      reviseDepth: 1,
    });
    expect(revised.revised_from_id).toBe(first.id);
    expect(revised.revise_depth).toBe(1);
  });

  it('getPendingByToolCall 只取 pending 且最新的一条', () => {
    const first = repo.insert({
      sessionId: SESSION_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: 'http.request',
      argsDigest: 'a'.repeat(64),
      challengeTokenHash: sha256Hex('t_1'),
      expiresAt: Date.now() + 300_000,
    });
    const second = repo.insert({
      sessionId: SESSION_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: 'http.request',
      argsDigest: 'b'.repeat(64),
      challengeTokenHash: sha256Hex('t_2'),
      expiresAt: Date.now() + 300_000,
    });
    expect(repo.getPendingByToolCall(TOOL_CALL_ID)!.id).toBe(second.id);
    repo.decide(first.id, 'allow_once', null);
    // first 已 decided，仍应返回 second
    expect(repo.getPendingByToolCall(TOOL_CALL_ID)!.id).toBe(second.id);
  });

  it('expireStale 只扫过期的 pending，返回清扫数', () => {
    const stale = repo.insert({
      sessionId: SESSION_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: 'http.request',
      argsDigest: 'a'.repeat(64),
      challengeTokenHash: sha256Hex('t_1'),
      expiresAt: Date.now() - 1000,
    }).id;
    const fresh = repo.insert({
      sessionId: SESSION_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: 'http.request',
      argsDigest: 'b'.repeat(64),
      challengeTokenHash: sha256Hex('t_2'),
      expiresAt: Date.now() + 300_000,
    }).id;
    expect(repo.expireStale(Date.now())).toBe(1);
    expect(repo.get(stale)!.status).toBe('expired');
    expect(repo.get(fresh)!.status).toBe('pending');
  });

  it('decide 过期行：expireStale 后 decision IS NULL 但 status 已非 pending', () => {
    const id = repo.insert({
      sessionId: SESSION_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: 'http.request',
      argsDigest: 'a'.repeat(64),
      challengeTokenHash: sha256Hex('t_1'),
      expiresAt: Date.now() - 1000,
    }).id;
    repo.expireStale(Date.now());
    // 守卫只挡 decision IS NULL；过期清扫把 status 改掉但不动 decision，
    // 服务层必须先查 status 再走 decide——此断言固化"清扫后 decide 仍可能成功"
    // 的现状，提醒调用方顺序（expireStale → status 检查 → decide）。
    const row = repo.decide(id, 'allow_once', null);
    expect(row.status).toBe('decided');
  });

  it('recordMismatch 累计计数并留存详情', () => {
    const id = insertApproval();
    expect(repo.recordMismatch(id, 'args digest 不匹配')).toBe(1);
    expect(repo.recordMismatch(id, 'token 不匹配')).toBe(2);
    const row = repo.get(id)!;
    expect(row.mismatch_count).toBe(2);
    expect(row.last_mismatch_detail).toBe('token 不匹配');
  });

  it('abortPendingForSession 只中止 pending，返回条数', () => {
    const a = insertApproval();
    const b = repo.insert({
      sessionId: SESSION_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: 'http.request',
      argsDigest: 'c'.repeat(64),
      challengeTokenHash: sha256Hex('t_3'),
      expiresAt: Date.now() + 300_000,
    }).id;
    repo.decide(a, 'allow_once', null);
    expect(repo.abortPendingForSession(SESSION_ID)).toBe(1);
    expect(repo.get(a)!.status).toBe('decided');
    expect(repo.get(b)!.status).toBe('aborted');
  });
});
