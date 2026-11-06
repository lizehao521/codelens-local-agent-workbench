// hmac-token 单测——审批挑战令牌（AC-04 / ADR-024）
// HMAC-SHA256 绑定 session + call + tool + args digest + 过期时间；
// 明文令牌只经 SSE 下发一次，落库的只有 SHA-256。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APPROVAL_TTL_MS,
  issueApprovalToken,
  verifyApprovalToken,
  type ApprovalTokenPayload,
} from '../src/utils/hmac.js';
import { sha256Hex } from '../src/utils/hash.js';

const PAYLOAD: Omit<ApprovalTokenPayload, 'expiresAt'> = {
  sessionId: 'se_001',
  toolCallId: 'tc_001',
  toolName: 'http.request',
  argsDigestValue: 'a'.repeat(64),
};

describe('hmac-token', () => {
  const original = process.env.AGENT_APPROVAL_SECRET;
  beforeAll(() => {
    process.env.AGENT_APPROVAL_SECRET = 'unit-test-secret';
  });
  afterAll(() => {
    if (original === undefined) delete process.env.AGENT_APPROVAL_SECRET;
    else process.env.AGENT_APPROVAL_SECRET = original;
  });

  it('签发后按同一载荷验证通过', () => {
    const issued = issueApprovalToken({ ...PAYLOAD, expiresAt: 0 });
    expect(issued.token.startsWith('t_')).toBe(true);
    expect(issued.expiresAt).toBeGreaterThan(Date.now());
    const result = verifyApprovalToken(issued.token, PAYLOAD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.sessionId).toBe(PAYLOAD.sessionId);
    expect(result.payload.toolName).toBe(PAYLOAD.toolName);
  });

  it('默认 TTL 为 5 分钟', () => {
    const before = Date.now();
    const issued = issueApprovalToken({ ...PAYLOAD, expiresAt: 0 });
    expect(issued.expiresAt - before).toBeGreaterThan(APPROVAL_TTL_MS - 5000);
    expect(issued.expiresAt - before).toBeLessThanOrEqual(APPROVAL_TTL_MS);
  });

  it('落库的是令牌哈希，不是明文', () => {
    const issued = issueApprovalToken({ ...PAYLOAD, expiresAt: 0 });
    expect(issued.tokenHash).toBe(sha256Hex(issued.token));
    expect(issued.tokenHash).not.toContain(issued.token);
  });

  it('篡改载荷段 → SIGNATURE_MISMATCH', () => {
    const issued = issueApprovalToken({ ...PAYLOAD, expiresAt: 0 });
    const dot = issued.token.lastIndexOf('.');
    const tampered = `t_${Buffer.from('se_evil|tc_001|http.request|' + 'a'.repeat(64) + '|99999999999999', 'utf8').toString('base64url')}.${issued.token.slice(dot + 1)}`;
    const result = verifyApprovalToken(tampered, PAYLOAD);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('SIGNATURE_MISMATCH');
  });

  it('载荷正确但绑定不符（换 session）→ BINDING_MISMATCH', () => {
    const issued = issueApprovalToken({ ...PAYLOAD, expiresAt: 0 });
    const result = verifyApprovalToken(issued.token, { ...PAYLOAD, sessionId: 'se_other' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('BINDING_MISMATCH');
  });

  it('参数摘要变化 → BINDING_MISMATCH（改参数重放旧令牌无效）', () => {
    const issued = issueApprovalToken({ ...PAYLOAD, expiresAt: 0 });
    const result = verifyApprovalToken(issued.token, { ...PAYLOAD, argsDigestValue: 'b'.repeat(64) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('BINDING_MISMATCH');
  });

  it('过期令牌 → EXPIRED', () => {
    const issued = issueApprovalToken({ ...PAYLOAD, expiresAt: Date.now() - 1000 });
    const result = verifyApprovalToken(issued.token, PAYLOAD);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('EXPIRED');
  });

  it('格式损坏 → MALFORMED', () => {
    for (const bad of ['', 'garbage', 't_.onlysig', 't_nodotatall']) {
      const result = verifyApprovalToken(bad, PAYLOAD);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('MALFORMED');
    }
  });
});
