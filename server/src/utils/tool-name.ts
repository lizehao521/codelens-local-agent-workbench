/**
 * Dual-track tool naming: canonical dotted names inside the platform, sanitized
 * underscore names on the wire. Single implementation shared by the normalizer,
 * the registry and the executor so sanitize/reverse can never drift apart.
 */

export const CANONICAL_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const MAX_WIRE_LENGTH = 64;

/** Rejects malformed canonical names at registration time, not at request time. */
export function assertCanonicalName(name: string): void {
  if (!CANONICAL_NAME_RE.test(name)) {
    throw new Error(
      `invalid canonical tool name "${name}": must match ${CANONICAL_NAME_RE.source}`,
    );
  }
}

/**
 * Canonical -> wire. Dots and every character outside `[a-zA-Z0-9_-]` collapse to `_`,
 * runs collapse, edges are trimmed, non-leading-letter results get a `t_` prefix,
 * and the result is capped at 64 characters.
 */
export function sanitizeToolName(canonical: string): string {
  const collapsed = canonical
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  const prefixed = /^[a-zA-Z]/.test(collapsed) ? collapsed : `t_${collapsed}`;
  return prefixed.slice(0, MAX_WIRE_LENGTH);
}

/**
 * Wire -> lookup key. Providers vary on case and stray whitespace; normalize before
 * hitting the reverse index so `HTTP_Request` and `http_request` resolve identically.
 */
export function normalizeWireName(wire: string): string {
  return wire.trim().toLowerCase();
}

export function buildReverseIndex(defs: readonly { name: string; wireName: string }[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const def of defs) {
    const key = normalizeWireName(def.wireName);
    // First registration wins: later conflicts were already suffixed at registration.
    if (!index.has(key)) index.set(key, def.name);
  }
  return index;
}

/** Resolves a wire name back to the canonical name, or null when unknown. */
export function resolveCanonical(index: ReadonlyMap<string, string>, wire: string): string | null {
  return index.get(normalizeWireName(wire)) ?? null;
}

/**
 * De-duplicates wire names across a registration batch by appending `_2`, `_3`, ...
 * Keeps the canonical names untouched.
 */
export function uniquifyWireNames(canonicals: readonly string[]): Map<string, string> {
  const taken = new Set<string>();
  const result = new Map<string, string>();
  for (const canonical of canonicals) {
    const base = sanitizeToolName(canonical);
    let candidate = base;
    let suffix = 2;
    while (taken.has(candidate)) {
      candidate = `${base.slice(0, MAX_WIRE_LENGTH - String(suffix).length - 1)}_${suffix}`;
      suffix += 1;
    }
    taken.add(candidate);
    result.set(canonical, candidate);
  }
  return result;
}
