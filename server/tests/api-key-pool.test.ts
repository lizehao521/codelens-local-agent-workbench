/**
 * Unit test for api-key-pool.ts — verifies key parsing, rotation, and fallback.
 * Run with: npx vitest run server/tests/api-key-pool.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getNextKey, getKeyAt, keyCount, resetRotation, hasRotation } from '../scripts/lib/api-key-pool.js';

describe('api-key-pool', () => {
  beforeEach(() => {
    vi.resetModules();
    // Clear module cache to re-initialize
    delete process.env.RSI_API_KEYS;
    delete process.env.RSI_API_KEY;
    delete process.env.LLM_SERVER_API_KEY;
    resetRotation();
  });

  it('parses comma-separated keys from RSI_API_KEYS', async () => {
    process.env.RSI_API_KEYS = 'key1,key2,key3';
    // Re-import to trigger init
    const { keyCount: kc } = await import('../scripts/lib/api-key-pool.js');
    expect(kc()).toBe(3);
  });

  it('falls back to RSI_API_KEY when pool empty', async () => {
    process.env.RSI_API_KEY = 'fallback-key';
    const { keyCount: kc, getNextKey: gnk } = await import('../scripts/lib/api-key-pool.js');
    expect(kc()).toBe(1);
    expect(gnk()).toBe('fallback-key');
  });

  it('falls back to LLM_SERVER_API_KEY when both pool and RSI_API_KEY empty', async () => {
    process.env.LLM_SERVER_API_KEY = 'legacy-key';
    const { keyCount: kc, getNextKey: gnk } = await import('../scripts/lib/api-key-pool.js');
    expect(kc()).toBe(1);
    expect(gnk()).toBe('legacy-key');
  });

  it('returns empty string when no keys configured', async () => {
    const { keyCount: kc, getNextKey: gnk } = await import('../scripts/lib/api-key-pool.js');
    expect(kc()).toBe(0);
    expect(gnk()).toBe('');
  });

  it('rotates keys round-robin', async () => {
    process.env.RSI_API_KEYS = 'a,b,c';
    const { getNextKey: gnk } = await import('../scripts/lib/api-key-pool.js');
    expect(gnk()).toBe('a');
    expect(gnk()).toBe('b');
    expect(gnk()).toBe('c');
    expect(gnk()).toBe('a'); // wraps around
  });

  it('getKeyAt returns correct key by index', async () => {
    process.env.RSI_API_KEYS = 'x,y,z';
    const { getKeyAt: gka } = await import('../scripts/lib/api-key-pool.js');
    expect(gka(0)).toBe('x');
    expect(gka(1)).toBe('y');
    expect(gka(2)).toBe('z');
    expect(gka(3)).toBe(''); // out of bounds
  });

  it('hasRotation returns true for multiple keys', async () => {
    process.env.RSI_API_KEYS = 'k1,k2';
    const { hasRotation: hr } = await import('../scripts/lib/api-key-pool.js');
    expect(hr()).toBe(true);
  });

  it('hasRotation returns false for single key', async () => {
    process.env.RSI_API_KEY = 'single';
    const { hasRotation: hr } = await import('../scripts/lib/api-key-pool.js');
    expect(hr()).toBe(false);
  });

  it('trims whitespace from keys', async () => {
    process.env.RSI_API_KEYS = '  key1 , key2  ,key3 ';
    const { getNextKey: gnk } = await import('../scripts/lib/api-key-pool.js');
    expect(gnk()).toBe('key1');
    expect(gnk()).toBe('key2');
    expect(gnk()).toBe('key3');
  });

  it('ignores empty entries', async () => {
    process.env.RSI_API_KEYS = 'key1,,key2,';
    const { keyCount: kc, getNextKey: gnk } = await import('../scripts/lib/api-key-pool.js');
    expect(kc()).toBe(2);
    expect(gnk()).toBe('key1');
    expect(gnk()).toBe('key2');
  });
});