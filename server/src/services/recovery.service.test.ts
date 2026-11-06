/**
 * Unit tests for RecoveryService (closes perf-report UNEXEC gap H-E2).
 *
 * The "cross-browser recovery" property is realised by the per-session salted
 * hash being scannable from a fresh client that holds no prior session state.
 * These tests prove: a correct code retrieves the right session from scratch,
 * the code is single-use, and malformed / look-alike / wrong codes are all
 * rejected. The raw code is never persisted — only its salted hash.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RecoveryService, generateRecoveryCode, recoveryCodeHash } from './recovery.service.js';
import type { SessionRow } from './memory/session.repository.js';

class FakeSessions {
  private store = new Map<string, SessionRow>();
  seed(id: string, overrides: Partial<SessionRow> = {}): SessionRow {
    const row: SessionRow = {
      id,
      title: 't',
      provider: 'p',
      model: 'm',
      channel_mode: 'auto',
      degraded: 0,
      message_count: 0,
      total_tokens: 0,
      device_token_hash: null,
      recovery_code_hash: null,
      recovery_code_used_at: null,
      recovery_failed_count: 0,
      recovery_locked_until: null,
      summary: null,
      created_at: 1,
      updated_at: 1,
      ...overrides,
    };
    this.store.set(id, row);
    return row;
  }
  get(id: string) {
    return this.store.get(id);
  }
  setRecoveryCode(id: string, hash: string) {
    this.store.get(id)!.recovery_code_hash = hash;
  }
  list(_limit: number, _offset: number) {
    return { items: [...this.store.values()] };
  }
  consumeRecoveryCode(id: string) {
    const s = this.store.get(id)!;
    if (s.recovery_code_used_at !== null) return false;
    s.recovery_code_used_at = Date.now();
    return true;
  }
  rebindDevice(id: string, hash: string) {
    this.store.get(id)!.device_token_hash = hash;
  }
  registerRecoveryFailure(id: string, lockedUntil: number | null) {
    const s = this.store.get(id)!;
    s.recovery_failed_count += 1;
    s.recovery_locked_until = lockedUntil;
  }
}

describe('generateRecoveryCode', () => {
  it('is 8 chars from the look-alike-free alphabet', () => {
    expect(generateRecoveryCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });
  it('is not deterministic across calls', () => {
    expect(generateRecoveryCode()).not.toBe(generateRecoveryCode());
  });
});

describe('RecoveryService · regenerate', () => {
  let fake: FakeSessions;
  let svc: RecoveryService;
  beforeEach(() => {
    fake = new FakeSessions();
    svc = new RecoveryService(fake as any);
    fake.seed('s1');
  });

  it('issues an 8-char code and stores only the salted hash', () => {
    const code = svc.regenerate('s1');
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    const row = fake.get('s1')!;
    expect(row.recovery_code_hash).toBe(recoveryCodeHash(code, 's1'));
    expect(row.recovery_code_hash).not.toContain(code); // raw code never stored
  });

  it('throws for an unknown session', () => {
    expect(() => svc.regenerate('nope')).toThrow();
  });
});

describe('RecoveryService · recover (H-E2)', () => {
  let fake: FakeSessions;
  let svc: RecoveryService;
  beforeEach(() => {
    fake = new FakeSessions();
    svc = new RecoveryService(fake as any);
  });

  it('retrieves the session from a fresh client with the correct code (cross-session)', () => {
    fake.seed('s1');
    const code = svc.regenerate('s1');
    const out = svc.recover(code);
    expect(out.sessionId).toBe('s1');
    expect(out.deviceToken).toBeTruthy();
  });

  it('rejects a wrong code', () => {
    fake.seed('s1');
    svc.regenerate('s1');
    expect(() => svc.recover('ZZZZZZZZ')).toThrow();
  });

  it('rejects malformed codes containing look-alike chars (0/O/1/I)', () => {
    fake.seed('s1');
    svc.regenerate('s1');
    expect(() => svc.recover('OOOOOOOO')).toThrow();
    expect(() => svc.recover('IIIIIIII')).toThrow();
    expect(() => svc.recover('12345678')).toThrow();
  });

  it('is single-use: the same code cannot be reused after consumption', () => {
    fake.seed('s1');
    const code = svc.regenerate('s1');
    expect(svc.recover(code).sessionId).toBe('s1'); // first use OK
    expect(() => svc.recover(code)).toThrow(); // replay rejected
  });

  it('scans across multiple sessions and only matches the owning one', () => {
    fake.seed('s1');
    fake.seed('s2');
    const code1 = svc.regenerate('s1');
    const out = svc.recover(code1);
    expect(out.sessionId).toBe('s1');
    expect(fake.get('s2')!.recovery_code_used_at).toBeNull(); // untouched
  });

  it('normalizes lowercase input before compare', () => {
    fake.seed('s1');
    const code = svc.regenerate('s1').toLowerCase();
    expect(svc.recover(code).sessionId).toBe('s1');
  });
});
