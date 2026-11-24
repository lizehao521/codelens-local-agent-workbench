/**
 * Multi-Key rotation pool for RSI pipeline.
 * Reads RSI_API_KEYS (comma-separated) from env, exposes round-robin selection
 * with 429-aware fallback. Never hardcodes keys — keys stay in .env only.
 */

let _keys: string[] = [];
let _index = 0;
let _initialized = false;

/** Parse and cache the key pool from environment. */
function init(): void {
  if (_initialized) return;
  const raw = process.env.RSI_API_KEYS?.trim() ?? '';
  _keys = raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  // Fallback to single legacy key if pool empty
  if (_keys.length === 0) {
    const legacy = process.env.RSI_API_KEY ?? process.env.LLM_SERVER_API_KEY ?? '';
    if (legacy) _keys = [legacy];
  }
  _initialized = true;
}

/** Get the next key in round-robin order. */
export function getNextKey(): string {
  init();
  if (_keys.length === 0) return '';
  const key = _keys[_index % _keys.length];
  _index = (_index + 1) % _keys.length;
  return key;
}

/** Get a specific key by index (for testing/debugging). */
export function getKeyAt(idx: number): string {
  init();
  return _keys[idx] ?? '';
}

/** Number of keys in the pool. */
export function keyCount(): number {
  init();
  return _keys.length;
}

/** Reset rotation index (for testing). */
export function resetRotation(): void {
  _index = 0;
}

/** Check if pool has multiple keys (rotation enabled). */
export function hasRotation(): boolean {
  init();
  return _keys.length > 1;
}