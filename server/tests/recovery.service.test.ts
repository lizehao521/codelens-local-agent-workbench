/**
 * Recovery service (AC-05) — P2-7 precise-failure-counting regression net.
 *
 * The shipped defect: a WRONG recovery code incremented the failure counter of
 * EVERY session that had a code, and the 5th wrong code wrote `locked_until`
 * to all of them — one typo locked every concurrent cross-device recovery for
 * 15 minutes (site-wide DoS). The fix keys lockout on attribution: only a
 * replay of an already-consumed code (which DOES identify its session) counts,
 * and it locks that session alone. Brute-force protection lives at the IP
 * layer (RECOVERY_RATE_LIMIT_PER_MIN, mounted in P1-5).
 *
 * Covered here:
 *   1. happy path: correct code recovers and is single-use
 *   2. wrong codes never touch any session's counter (the DoS regression)
 *   3. replays increment ONLY the matched session
 *   4. the 5th replay locks ONLY that session — others stay recoverable
 *   5. a locked session rejects with RECOVERY_LOCKED (per-session check)
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { SessionRepository } from '../src/services/memory/session.repository.js';
import { RecoveryService, generateRecoveryCode, recoveryCodeHash } from '../src/services/recovery.service.js';
import { AppError } from '../src/utils/errors.js';

let dir: string;
let db: Db;
let sessions: SessionRepository;
let recovery: RecoveryService;

/** Creates a session whose live recovery code is the returned plaintext. */
function sessionWithCode(tag: string): { id: string; code: string } {
  const created = sessions.create({ provider: 'openai', model: 'gpt-4o-mini', deviceTokenHash: `dt_${tag}` })!;
  const code = generateRecoveryCode(); // valid alphabet by construction
  sessions.setRecoveryCode(created.id, recoveryCodeHash(code, created.id));
  return { id: created.id, code };
}

function failedCount(sessionId: string): number {
  return sessions.get(sessionId)!.recovery_failed_count;
}

function lockedUntil(sessionId: string): number | null {
  return sessions.get(sessionId)!.recovery_locked_until;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'codelens-recovery-'));
  db = createDb(path.join(dir, 'recovery.db'));
  db.exec(SCHEMA_SQL);
  sessions = new SessionRepository(db);
  recovery = new RecoveryService(sessions);
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

/** Valid format, matches nothing (alphabet excludes 0/O/1/I). */
const WRONG_CODE = 'ZZZZ9999';

describe('RecoveryService (P2-7 precise counting)', () => {
  it('correct code recovers the session, rebinds the device token, and is single-use', () => {
    const { id, code } = sessionWithCode('a');

    const first = recovery.recover(code);
    expect(first.sessionId).toBe(id);
    expect(first.deviceToken).toMatch(/^dt_/);

    expect(() => recovery.recover(code)).toThrowError(expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }));
    expect(sessions.get(id)!.recovery_code_used_at).not.toBeNull();
  });

  it('wrong codes never touch any session counter — no global lockout (the P2-7 DoS)', () => {
    const a = sessionWithCode('a');
    const b = sessionWithCode('b');

    // Four wrong codes: before the fix this incremented BOTH sessions and the
    // fifth would have locked both for 15 minutes.
    for (let i = 0; i < 4; i += 1) {
      expect(() => recovery.recover(WRONG_CODE)).toThrowError(
        expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }),
      );
    }

    expect(failedCount(a.id)).toBe(0);
    expect(failedCount(b.id)).toBe(0);
    expect(lockedUntil(a.id)).toBeNull();
    expect(lockedUntil(b.id)).toBeNull();

    // A fifth wrong code still locks nobody; both sessions remain recoverable.
    expect(() => recovery.recover(WRONG_CODE)).toThrowError(
      expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }),
    );
    expect(recovery.recover(a.code).sessionId).toBe(a.id);
    expect(recovery.recover(b.code).sessionId).toBe(b.id);
  });

  it('replaying a consumed code increments ONLY the matched session', () => {
    const a = sessionWithCode('a');
    const b = sessionWithCode('b');
    recovery.recover(a.code); // consume A's code

    expect(() => recovery.recover(a.code)).toThrowError(
      expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }),
    );

    expect(failedCount(a.id)).toBe(1);
    expect(failedCount(b.id)).toBe(0); // untouched — attribution works
  });

  it('the 5th replay locks ONLY that session; concurrent recoveries keep working', () => {
    const a = sessionWithCode('a');
    const b = sessionWithCode('b');
    recovery.recover(a.code);

    for (let i = 0; i < 4; i += 1) {
      expect(() => recovery.recover(a.code)).toThrowError(
        expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }),
      );
    }
    expect(failedCount(a.id)).toBe(4);
    expect(lockedUntil(a.id)).toBeNull();

    let locked: unknown;
    try {
      recovery.recover(a.code);
    } catch (err) {
      locked = err;
    }
    expect(locked).toBeInstanceOf(AppError);
    expect((locked as AppError).code).toBe('RECOVERY_LOCKED');
    expect((locked as AppError).status).toBe(423);
    expect((locked as AppError).details?.retryAfterMs).toBeGreaterThan(0);
    expect(lockedUntil(a.id)).toBeGreaterThan(Date.now());

    // B was never attacked and must stay fully recoverable — the old code
    // would have locked B along with A.
    expect(recovery.recover(b.code).sessionId).toBe(b.id);
  });

  it('a locked session rejects further attempts with RECOVERY_LOCKED (per-session check)', () => {
    const a = sessionWithCode('a');
    recovery.recover(a.code);
    for (let i = 0; i < 5; i += 1) {
      try {
        recovery.recover(a.code);
      } catch {
        /* expected */
      }
    }

    expect(() => recovery.recover(a.code)).toThrowError(
      expect.objectContaining({ code: 'RECOVERY_LOCKED', status: 423 }),
    );
  });

  it('malformed codes are rejected before any DB work', () => {
    sessionWithCode('a');
    expect(() => recovery.recover('short')).toThrowError(
      expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }),
    );
    expect(() => recovery.recover('ABC0O1I2')).toThrowError( // look-alike chars
      expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }),
    );
  });
});
