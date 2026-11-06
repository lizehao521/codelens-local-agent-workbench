/**
 * Approval challenge tokens: HMAC-SHA256 bound to session + call + tool + args digest
 * + expiry. The plaintext token is emitted exactly once over SSE; only its SHA-256
 * is persisted (ADR-024).
 */

import { createHmac } from 'node:crypto';
import { randomHex, safeEqualHex, sha256Hex } from './hash.js';

export const APPROVAL_TTL_MS = 300_000;
const SIG_LENGTH = 32;

/** 运行时注入的已解析密钥（桌面端/env/磁盘持久化，见 approval-secret.ts）。 */
let resolvedSecret: string | null = null;

/**
 * 注入解析后的主密钥（runtime 启动时调用）。空串表示清除注入，回退到 env / 临时密钥
 * 路径，保证既有单测（直接调用 issue/verify）行为不变。
 */
export function setApprovalSecret(value: string): void {
  resolvedSecret = value.length > 0 ? value : null;
}

export interface ApprovalTokenPayload {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  argsDigestValue: string;
  expiresAt: number;
}

export interface IssuedToken {
  token: string;
  tokenHash: string;
  expiresAt: number;
}

function secret(): string {
  if (resolvedSecret) return resolvedSecret;
  const value = process.env.AGENT_APPROVAL_SECRET;
  if (value && value.length > 0) return value;
  // Ephemeral dev/test secret: pending approvals do not survive a restart (runtime 会注入持久化密钥).
  let cached = process.env.__CODELENS_APPROVAL_SECRET__;
  if (!cached) {
    cached = randomHex(32);
    process.env.__CODELENS_APPROVAL_SECRET__ = cached;
  }
  return cached;
}

function sign(plainPayload: string, key: string): string {
  return createHmac('sha256', key).update(plainPayload).digest('base64url').slice(0, SIG_LENGTH);
}

function toPlainPayload(p: ApprovalTokenPayload): string {
  return [p.sessionId, p.toolCallId, p.toolName, p.argsDigestValue, p.expiresAt].join('|');
}

/** Issues a token bound to the supplied payload with a 5 minute expiry. */
export function issueApprovalToken(p: ApprovalTokenPayload): IssuedToken {
  const expiresAt = p.expiresAt > 0 ? p.expiresAt : Date.now() + APPROVAL_TTL_MS;
  const plain = toPlainPayload({ ...p, expiresAt });
  const key = secret();
  const token = `t_${Buffer.from(plain, 'utf8').toString('base64url')}.${sign(plain, key)}`;
  return { token, tokenHash: sha256Hex(token), expiresAt };
}

export type VerifyFailure = 'MALFORMED' | 'SIGNATURE_MISMATCH' | 'EXPIRED' | 'BINDING_MISMATCH';

export type VerifyResult =
  | { ok: true; payload: ApprovalTokenPayload }
  | { ok: false; reason: VerifyFailure };

function constantTimeEqualSig(expected: string, actual: string): boolean {
  // Both are exactly SIG_LENGTH base64url characters in the happy path; fall back to
  // hash equality so arbitrary lengths never reach timingSafeEqual directly.
  return safeEqualHex(sha256Hex(expected), sha256Hex(actual));
}

/**
 * Verifies a presented token against the challenge it claims to belong to.
 * Signature check first (cheap, no DB), then binding and expiry.
 */
export function verifyApprovalToken(
  token: string,
  expected: Omit<ApprovalTokenPayload, 'expiresAt'>,
): VerifyResult {
  if (!token.startsWith('t_')) return { ok: false, reason: 'MALFORMED' };
  const dot = token.lastIndexOf('.');
  if (dot <= 2) return { ok: false, reason: 'MALFORMED' };
  const encoded = token.slice(2, dot);
  const providedSig = token.slice(dot + 1);
  let plain: string;
  try {
    plain = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (!constantTimeEqualSig(sign(plain, secret()), providedSig)) {
    return { ok: false, reason: 'SIGNATURE_MISMATCH' };
  }
  const parts = plain.split('|');
  if (parts.length !== 5) return { ok: false, reason: 'MALFORMED' };
  const [sessionId, toolCallId, toolName, argsDigestValue, expiresRaw] = parts as [
    string, string, string, string, string,
  ];
  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'MALFORMED' };
  if (
    sessionId !== expected.sessionId ||
    toolCallId !== expected.toolCallId ||
    toolName !== expected.toolName ||
    argsDigestValue !== expected.argsDigestValue
  ) {
    return { ok: false, reason: 'BINDING_MISMATCH' };
  }
  if (Date.now() > expiresAt) return { ok: false, reason: 'EXPIRED' };
  return {
    ok: true,
    payload: { sessionId, toolCallId, toolName, argsDigestValue, expiresAt },
  };
}
