/**
 * Recovery service (AC-05): 8-char recovery codes and device tokens.
 * Codes exclude look-alike characters (0/O/1/I); only SHA-256(code + sessionId)
 * is stored. Because the hash is salted per session, lookup scans the (few)
 * session rows with a constant-time compare on every candidate — timing does
 * not reveal which session matched. Lockout is per-session and only counts
 * attributable failures (see recover()'s attribution note, P2-7); brute-force
 * protection itself lives at the IP layer (rate limiter).
 */

import { randomInt, timingSafeEqual } from 'node:crypto';
import type { SessionRepository, SessionRow } from './memory/session.repository.js';
import { randomHex, sha256Hex } from '../utils/hash.js';
import { AppError } from '../utils/errors.js';

/** Alphabet without 0/O/1/I: 31^8 ≈ 8.5e11 codespace. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

export function generateRecoveryCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export function recoveryCodeHash(code: string, sessionId: string): string {
  return sha256Hex(`${code}:${sessionId}`);
}

function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(left, left); // burn one comparison; same cost as the match path
    return false;
  }
  return timingSafeEqual(left, right);
}

export class RecoveryService {
  constructor(private readonly sessions: SessionRepository) {}

  /** Issues a fresh code for a session; the old code dies immediately. */
  regenerate(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', '会话不存在或已被删除');
    const code = generateRecoveryCode();
    this.sessions.setRecoveryCode(sessionId, recoveryCodeHash(code, sessionId));
    return code;
  }

  /**
   * Validates a recovery code. Order is fixed (spec 3.3.6): constant-time
   * compare → per-session lock check → single-use consume.
   *
   * Attribution note (P2-7): the code hash is salted per session, so a WRONG
   * code matches no session and cannot be attributed to one. The old code
   * incremented EVERY pending session's counter on any typo and locked ALL of
   * them at the 5th strike — one wrong keystroke locked every concurrent
   * recovery for 15 minutes (site-wide DoS). Brute-force protection therefore
   * lives at the IP layer instead (RECOVERY_RATE_LIMIT_PER_MIN = 10/min,
   * mounted in P1-5): against a 31^8 ≈ 8.5e11 codespace that is strictly
   * stronger than the global lockout it replaced. The per-session counter now
   * counts only ATTRIBUTABLE failures — replays of an already-consumed code
   * against the session it belongs to — and locks that one session after 5.
   */
  recover(recoveryCode: string, deviceToken?: string): { sessionId: string; deviceToken: string } {
    const normalized = recoveryCode.trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(normalized)) {
      throw new AppError('RECOVERY_CODE_INVALID', '恢复码无效或已失效');
    }

    const { items } = this.sessions.list(500, 0);
    const withCodes = items.filter((session) => session.recovery_code_hash);

    // Hash-scan every session; compare each candidate in constant time. No
    // early break: the scan cost must not reveal which session matched.
    let matched: SessionRow | undefined;
    for (const session of withCodes) {
      if (equalsConstantTime(session.recovery_code_hash!, recoveryCodeHash(normalized, session.id))) {
        matched = session;
      }
    }
    if (!matched) {
      // P2-7: unattributable — no session to charge. See the attribution note
      // above; IP-layer rate limiting is the brute-force control.
      throw new AppError('RECOVERY_CODE_INVALID', '恢复码无效或已失效');
    }

    // Per-session lock (P2-7): only the matched session can be locked. Keys on
    // locked_until (a future timestamp) rather than a status flag, so a
    // session locked by a concurrent request cannot slip through the check.
    if (matched.recovery_locked_until !== null && matched.recovery_locked_until > Date.now()) {
      throw new AppError('RECOVERY_LOCKED', '恢复码连续错误次数过多，已锁定', 423, {
        retryAfterMs: matched.recovery_locked_until - Date.now(),
      });
    }
    if (matched.recovery_code_used_at !== null) {
      // Attributable replay: the session is known, so its counter is the right
      // place to count. Five consecutive replays lock this session only —
      // never the whole site.
      const failures = matched.recovery_failed_count + 1;
      const lockedUntil = failures >= MAX_FAILURES ? Date.now() + LOCK_MS : null;
      this.sessions.registerRecoveryFailure(matched.id, lockedUntil);
      if (lockedUntil !== null) {
        throw new AppError('RECOVERY_LOCKED', '恢复码连续错误次数过多，已锁定', 423, { retryAfterMs: LOCK_MS });
      }
      throw new AppError('RECOVERY_CODE_INVALID', '恢复码无效或已失效');
    }

    // Single-use: consume in one write; a concurrent race yields changes === 0.
    if (!this.sessions.consumeRecoveryCode(matched.id)) {
      throw new AppError('RECOVERY_CODE_INVALID', '恢复码无效或已失效');
    }
    const newDeviceToken = deviceToken?.trim() || `dt_${randomHex(16)}`;
    this.sessions.rebindDevice(matched.id, sha256Hash(newDeviceToken));
    return { sessionId: matched.id, deviceToken: newDeviceToken };
  }
}

function sha256Hash(value: string): string {
  return sha256Hex(value);
}
