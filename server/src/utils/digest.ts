/**
 * Argument digest: canonical JSON + SHA-256.
 * Shared by the approval token binding and the loop detector so "the arguments the
 * user approved" and "the arguments that count as a repeat" use identical keys.
 */

import { sha256Hex } from './hash.js';

/** Fields whose value changes between semantically identical calls. */
const VOLATILE_KEYS = new Set(['timeoutMs', 'maxBytes', 'maxEntries', 'contextLines']);

/** Recursively sorts object keys and drops volatile fields. */
export function canonicalizeArgs(value: unknown, topLevel = true): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeArgs(item, false));
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const entries = Object.entries(source)
    .filter(([key]) => !(topLevel && VOLATILE_KEYS.has(key)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries) out[key] = canonicalizeArgs(item, false);
  return out;
}

/** Stable string form: key order independent, volatile fields excluded. */
export function canonicalArgsJson(args: Record<string, unknown>): string {
  return JSON.stringify(canonicalizeArgs(args));
}

/** SHA-256 over the canonical JSON. Used for `args_digest` columns. */
export function argsDigest(args: Record<string, unknown>): string {
  return sha256Hex(canonicalArgsJson(args));
}

/** Loop-detector key: tool name + argument digest. */
export function callSignature(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}:${argsDigest(args)}`;
}
