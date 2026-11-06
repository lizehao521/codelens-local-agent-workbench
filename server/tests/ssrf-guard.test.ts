// ssrf-guard 单测（AC-07 / 五重校验）—— 纯决策函数，不打网络
// 覆盖：协议白名单 / 内嵌凭据 / http 默认拒绝 / 白名单 / 禁用网段 / IPv6 映射 / DNS 解析阶段

import { describe, expect, it, vi } from 'vitest';
import {
  inspectUrl,
  isBlockedIp,
  MAX_REDIRECTS,
  validateRedirect,
  validateTarget,
} from '../src/utils/ssrf-guard.js';

describe('ssrf-guard', () => {
  it('协议白名单：仅 http/https', () => {
    expect(inspectUrl('ftp://example.com').ok).toBe(false);
    expect(inspectUrl('file:///etc/passwd').ok).toBe(false);
    expect(inspectUrl('javascript:alert(1)').ok).toBe(false);
    expect(inspectUrl('https://example.com').ok).toBe(true);
  });

  it('URL 内嵌凭据被拒', () => {
    const verdict = inspectUrl('https://user:pass@example.com');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('EMBEDDED_CREDENTIALS');
  });

  it('http 默认拒绝（未开 HTTP_ALLOW_INSECURE）', () => {
    const verdict = inspectUrl('http://example.com');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('NON_HTTPS');
  });

  it('禁用网段：IPv4 全部命中', () => {
    for (const ip of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254', // 云元数据
      '172.16.0.1',
      '192.168.1.1',
      '198.18.0.1',
      '224.0.0.1',
      '240.0.0.1',
    ]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('1.1.1.1')).toBe(false);
  });

  it('禁用网段：IPv6（回环 / 唯一本地 / 链路本地 / 映射 v4）', () => {
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('::')).toBe(true);
    expect(isBlockedIp('fc00::1')).toBe(true);
    expect(isBlockedIp('fd12:3456::1')).toBe(true);
    expect(isBlockedIp('fe80::1')).toBe(true);
    expect(isBlockedIp('::ffff:10.0.0.1')).toBe(true); // 按内嵌 v4 判定
    expect(isBlockedIp('2002:10.0.0.1::')).toBe(true); // 6to4 内嵌 v4
    expect(isBlockedIp('64:ff9b::10.0.0.1')).toBe(true); // NAT64
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
  });

  it('域名白名单：经 config 快照生效——未设置时放行，设置后严格匹配', async () => {
    // P2-8: the allowlist now comes from the validated config singleton
    // (env.ts), so the env var must be set BEFORE the module graph loads.
    vi.resetModules();
    delete process.env.HTTP_TOOL_ALLOWLIST;
    const open = await import('../src/utils/ssrf-guard.js');
    expect(open.inspectUrl('https://anything.example').ok).toBe(true);

    vi.resetModules();
    process.env.HTTP_TOOL_ALLOWLIST = 'api.allowed.com';
    const guarded = await import('../src/utils/ssrf-guard.js');
    expect(guarded.inspectUrl('https://api.allowed.com/x').ok).toBe(true);
    const blocked = guarded.inspectUrl('https://evil.com/x');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('ALLOWLIST');

    delete process.env.HTTP_TOOL_ALLOWLIST;
    vi.resetModules();
  });

  it('HTTP_ALLOW_INSECURE：经 config 快照生效，默认只允许 https', async () => {
    vi.resetModules();
    delete process.env.HTTP_ALLOW_INSECURE;
    const strict = await import('../src/utils/ssrf-guard.js');
    const denied = strict.inspectUrl('http://example.com');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('NON_HTTPS');

    vi.resetModules();
    process.env.HTTP_ALLOW_INSECURE = 'true';
    const loose = await import('../src/utils/ssrf-guard.js');
    expect(loose.inspectUrl('http://example.com').ok).toBe(true);

    delete process.env.HTTP_ALLOW_INSECURE;
    vi.resetModules();
  });

  it('字面 IP 目标：禁用 IP 直接拒，公网 IP 直接过', async () => {
    const privateLiteral = await validateTarget('https://127.0.0.1/x');
    expect(privateLiteral.ok).toBe(false);
    const publicLiteral = await validateTarget('https://8.8.8.8/x');
    expect(publicLiteral.ok).toBe(true);
    if (publicLiteral.ok) expect(publicLiteral.addresses).toEqual(['8.8.8.8']);
  });

  it('域名解析失败 → NO_RESOLVED_ADDRESS（不打网络也能验：保留主机名）', async () => {
    const verdict = await validateTarget('https://definitely-not-a-real-host-codelens.invalid/x');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('NO_RESOLVED_ADDRESS');
  });

  it('重定向上限为 3 跳', () => {
    expect(MAX_REDIRECTS).toBe(3);
  });

  it('重定向目标重跑完整校验（相对 Location 亦可）', async () => {
    const verdict = await validateRedirect('/next', new URL('https://example.com/start'));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.url?.toString()).toBe('https://example.com/next');
  });
});
