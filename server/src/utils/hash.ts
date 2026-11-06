/** Hashing helpers: SHA-256 digests, random ids, and constant-time comparison. */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Lowercase hex string of cryptographically strong random bytes. */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** uuid v4 from the CSPRNG. Used for session / tool_call primary keys. */
export function newUuid(): string {
  return randomUUID();
}

/**
 * Constant-time comparison of hex digests. Length mismatch short-circuits but still
 * burns one comparison so the timing profile does not differ from the match path.
 */
export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Prefixed random id: approvals `ap_`, results `r_`, messages `m_`, calls `call_`. */
export function prefixedId(prefix: string, bytes = 12): string {
  return `${prefix}_${randomHex(bytes)}`;
}
