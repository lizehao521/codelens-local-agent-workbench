/**
 * 自我升级判据：IP / 端口的**语义**判定，而不是**书写形态**判定。
 *
 * 为什么这条判据存在：
 * `isBlockedIp` 靠 `split(':').pop()` 取 IPv6 尾部来识别 IPv4-mapped 地址，
 * 这只对 `::ffff:10.0.0.1` 这种点分写法成立。而同一个地址写成 `::ffff:a00:1`
 * （十六进制，也就是 WHATWG URL 序列化后的规范形态）就判不出来；回环写全展开
 * `0:0:0:0:0:0:0:1` 也判不出来。安全判定依赖字符串长相，等于没判定。
 *
 * 同一类错误的另外两处：
 *  - `inspectUrl` 无显式端口时一律报 443，与协议无关（http 的默认端口是 80）。
 *    调用方 `http-request.tool.ts` 自己按协议补了 80，所以字段在被读之前
 *    一直是错的——这类「暂时没人读的错值」正是下一次事故的引信。
 *  - `validateTarget` 用 `net.isIP(hostname)` 判断是不是字面 IP，而 WHATWG URL
 *    会给 IPv6 字面量加方括号（`[::1]`），`net.isIP('[::1]') === 0`，于是回环
 *    被当成域名送去 DNS 解析，最终以「解析失败」拒绝——拦是拦住了，但原因是假的。
 *
 * 判据只断言**可观察的产品行为**，不锁实现：可以用位运算、可以用 node:net 的
 * 规范形、可以自己展开，只要行为对。
 */

import dns from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectUrl, isBlockedIp, validateTarget } from '../../src/utils/ssrf-guard.js';

describe('isBlockedIp：按数值语义判定，不依赖书写形态', () => {
  it('IPv4-mapped IPv6 的十六进制形态同样命中私网', () => {
    expect(isBlockedIp('::ffff:a00:1')).toBe(true); // 10.0.0.1
    expect(isBlockedIp('::ffff:7f00:1')).toBe(true); // 127.0.0.1
    expect(isBlockedIp('::FFFF:A00:1')).toBe(true); // 大小写不敏感
  });

  it('全展开写法与未指定地址同样命中', () => {
    expect(isBlockedIp('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isBlockedIp('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(true);
    expect(isBlockedIp('0:0:0:0:0:0:0:0')).toBe(true);
  });

  it('不误伤公网地址（含公网的映射形态）', () => {
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedIp('::ffff:808:808')).toBe(false); // 8.8.8.8 的十六进制形态
    expect(isBlockedIp('2001:4860:4860::8888')).toBe(false);
  });
});

describe('inspectUrl：默认端口由协议决定', () => {
  it('http → 80，https → 443，显式端口优先', () => {
    expect(inspectUrl('http://example.com/x', { allowInsecure: true }).port).toBe(80);
    expect(inspectUrl('https://example.com/x').port).toBe(443);
    expect(inspectUrl('http://example.com:8080/x', { allowInsecure: true }).port).toBe(8080);
  });
});

describe('方括号形式的 IP 字面量按 IP 判定，不当作域名去解析', () => {
  it('https://[::1] 应报 DISALLOWED_IP，而不是「解析失败」', async () => {
    const verdict = await validateTarget('https://[::1]/');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('DISALLOWED_IP');
  });

  it('https://[::ffff:10.0.0.1] 同样应报 DISALLOWED_IP', async () => {
    const verdict = await validateTarget('https://[::ffff:10.0.0.1]/');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('DISALLOWED_IP');
  });
});

describe('DNS 返回的地址形态不受我们控制', () => {
  afterEach(() => vi.restoreAllMocks());

  it('解析结果为 ::ffff:a00:1 时必须拦下', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '::ffff:a00:1', family: 6 },
    ] as unknown as dns.LookupAddress[]);
    const verdict = await validateTarget('https://evil.example/');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('DISALLOWED_IP');
  });
});
