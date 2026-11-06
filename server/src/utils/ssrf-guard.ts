/**
 * SSRF guard (five-fold): protocol allowlist, credential rejection, DNS-resolve-then-check
 * every A/AAAA record, connect to the validated IP only (no TOCTOU rebind), and per-hop
 * revalidation on redirects. All pure decisions; the caller performs I/O.
 */

import dns from 'node:dns';
import net from 'node:net';
import { config } from '../config/env.js';

export type BlockReason =
  | 'BAD_PROTOCOL'
  | 'BAD_URL'
  | 'EMBEDDED_CREDENTIALS'
  | 'NON_HTTPS'
  | 'ALLOWLIST'
  | 'DISALLOWED_IP'
  | 'NO_RESOLVED_ADDRESS';

export interface UrlVerdict {
  ok: boolean;
  reason?: BlockReason;
  message?: string;
  /** Presentation URL (unchanged): always use this for requests and the Host header. */
  url?: URL;
  hostname?: string;
  port?: number;
  /** Every validated address of the hostname; connect to one of these, never re-resolve. */
  addresses?: string[];
}

/** A verdict that passed every stage: url/hostname/addresses are guaranteed present. */
export type UrlVerdictOk = UrlVerdict & {
  ok: true;
  url: URL;
  hostname: string;
  addresses: string[];
};

/** Type guard for callers that must connect (addresses must be non-empty). */
export function isVerdictOk(verdict: UrlVerdict): verdict is UrlVerdictOk {
  return (
    verdict.ok &&
    verdict.url !== undefined &&
    verdict.hostname !== undefined &&
    verdict.addresses !== undefined &&
    verdict.addresses.length > 0
  );
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

interface Cidr4 {
  base: number;
  bits: number;
}

const BLOCKED_V4: Cidr4[] = [
  cidr('0.0.0.0', 8), // "this" network
  cidr('10.0.0.0', 8), // private
  cidr('100.64.0.0', 10), // carrier NAT
  cidr('127.0.0.0', 8), // loopback
  cidr('169.254.0.0', 16), // link-local / cloud metadata
  cidr('172.16.0.0', 12), // private
  cidr('192.168.0.0', 16), // private
  cidr('198.18.0.0', 15), // benchmarking
  cidr('224.0.0.0', 4), // multicast
  cidr('240.0.0.0', 4), // reserved
];

function cidr(ip: string, bits: number): Cidr4 {
  return { base: ipv4ToInt(ip), bits };
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inBlockedV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  const mask = (bits: number) => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);
  for (const range of BLOCKED_V4) {
    if ((value & mask(range.bits)) >>> 0 === (range.base & mask(range.bits)) >>> 0) return true;
  }
  return false;
}

/** IPv4-mapped IPv6 (`::ffff:10.0.0.1`) must be judged by its embedded IPv4 address. */
function unmapIpv6(ip: string): string | null {
  const lower = ip.toLowerCase();
  const tail = lower.split(':').pop() ?? '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
  return null;
}

export function isBlockedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return inBlockedV4(ip);
  if (version === 6) {
    const mapped = unmapIpv6(ip);
    if (mapped) return inBlockedV4(mapped);
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (lower.startsWith('2002:')) return true; // 6to4 (embeds IPv4)
    if (lower.startsWith('64:ff9b:')) return true; // NAT64
    return false;
  }
  return true;
}

function allowlist(): string[] {
  // P2-8: sourced from the validated config surface. This used to be a bare
  // process.env read — invisible to env.ts, so the key never appeared in the
  // config manifest and a typo'd value failed silently (no restriction).
  // Values snapshot at process start, same as every other knob; rotating the
  // allowlist now requires a restart, which is the safer trade for a
  // security-critical setting.
  return config.httpToolAllowlist;
}

function insecureHttpAllowed(): boolean {
  return config.httpAllowInsecure;
}

/** Stage 1-2: syntactic checks that need no network access. */
export function inspectUrl(
  rawUrl: string,
  opts?: { allowInsecure?: boolean; allowPrivate?: boolean },
): UrlVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'BAD_URL', message: 'URL 格式不合法' };
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: 'BAD_PROTOCOL', message: `协议 ${url.protocol} 不被允许` };
  }
  // WHATWG URL strips `user:pass@` out of `host`, so credentials must be read
  // from url.username / url.password — testing `url.host` never fires.
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'EMBEDDED_CREDENTIALS', message: 'URL 内嵌凭据被拒绝' };
  }
  if (url.protocol === 'http:' && !(opts?.allowInsecure ?? insecureHttpAllowed())) {
    return { ok: false, reason: 'NON_HTTPS', message: '默认只允许 https，请开启 allowInsecure / HTTP_ALLOW_INSECURE' };
  }
  const list = allowlist();
  if (list.length > 0 && !list.includes(url.hostname.toLowerCase())) {
    return { ok: false, reason: 'ALLOWLIST', message: `域名 ${url.hostname} 不在白名单内` };
  }
  return { ok: true, url, hostname: url.hostname, port: url.port ? Number(url.port) : 443 };
}

/**
 * Stages 1-4. Resolves every address for the hostname and rejects the request if ANY
 * resolved address falls in a blocked range. The returned addresses must be reused for
 * the connection so DNS rebinding cannot swap in a private address later.
 */
export async function validateTarget(
  rawUrl: string,
  opts?: { allowInsecure?: boolean; allowPrivate?: boolean },
): Promise<UrlVerdict> {
  const base = inspectUrl(rawUrl, opts);
  if (!base.ok || !base.url || !base.hostname) return base;

  const literal = net.isIP(base.hostname) !== 0;
  if (literal) {
    if (!opts?.allowPrivate && isBlockedIp(base.hostname)) {
      return { ok: false, reason: 'DISALLOWED_IP', message: `目标 IP ${base.hostname} 位于禁用网段` };
    }
    return { ...base, addresses: [base.hostname] };
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.promises.lookup(base.hostname, { all: true });
  } catch {
    return { ok: false, reason: 'NO_RESOLVED_ADDRESS', message: `域名 ${base.hostname} 解析失败` };
  }
  if (records.length === 0) {
    return { ok: false, reason: 'NO_RESOLVED_ADDRESS', message: `域名 ${base.hostname} 无解析结果` };
  }
  const addresses: string[] = [];
  for (const record of records) {
    if (!opts?.allowPrivate && isBlockedIp(record.address)) {
      return { ok: false, reason: 'DISALLOWED_IP', message: `域名解析到禁用地址 ${record.address}` };
    }
    addresses.push(record.address);
  }
  return { ...base, addresses };
}

/** Stage 5 entry point: re-run the full check for each redirect hop. */
export async function validateRedirect(rawLocation: string, from: URL): Promise<UrlVerdict> {
  let next: string;
  try {
    next = new URL(rawLocation, from).toString();
  } catch {
    return { ok: false, reason: 'BAD_URL', message: '重定向目标不是合法 URL' };
  }
  return validateTarget(next);
}

export const MAX_REDIRECTS = 3;
