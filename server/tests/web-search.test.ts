/**
 * web.search 的纯解析测试 —— 检索结果必须能稳定变成 references。
 *
 * 不打网络：网络可达性属于运行期事实，由端到端跑验证；
 * 这里钉的是「同样的 RSS 必然解析出同样的条目」。
 */
import { describe, it, expect } from 'vitest';
import { parseBingRss } from '../src/tools/builtin/web-search.tool.js';
import { validateForgeSpec } from '../src/tools/builtin/tool-forge.tool.js';

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Exponential Backoff &amp; Retry</title><link>https://example.com/backoff</link>
<description>&lt;b&gt;如何&lt;/b&gt;实现指数退避重试</description></item>
<item><title>Idempotent Retry Design</title><link>https://example.com/idempotent</link>
<description>幂等重试设计要点</description></item>
<item><title>无链接条目</title><description>应被跳过</description></item>
</channel></rss>`;

describe('parseBingRss', () => {
  it('解析出 title / url / snippet，并跳过缺少链接的条目', () => {
    const out = parseBingRss(RSS);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      title: 'Exponential Backoff & Retry',
      url: 'https://example.com/backoff',
      snippet: '如何 实现指数退避重试',
    });
  });

  it('limit 生效', () => {
    expect(parseBingRss(RSS, 1)).toHaveLength(1);
  });

  it('空输入 → 空数组（不抛）', () => {
    expect(parseBingRss('')).toEqual([]);
  });
});

describe('tool.forge references 校验', () => {
  const base = {
    name: 'read_head',
    description: '读固定行',
    why_not_existing: '现有工具无法一次调用固定行窗口',
    steps: [{ tool: 'fs_read', args: { path: 'a.txt', lineEnd: 3 } }],
  };

  it('合法 http(s) 链接被保留', () => {
    const r = validateForgeSpec({
      ...base,
      references: [{ title: 't', url: 'https://example.com/x' }],
    });
    expect(r.ok).toBe(true);
    expect(r.spec?.references).toEqual([{ title: 't', url: 'https://example.com/x' }]);
  });

  it('非 http 链接被丢弃，但不毁掉整个创建请求', () => {
    const r = validateForgeSpec({
      ...base,
      references: [{ title: 'bad', url: 'ftp://x' }, { title: 'ok', url: 'http://example.com' }],
    });
    expect(r.ok).toBe(true);
    expect(r.spec?.references).toHaveLength(1);
    expect(r.spec?.references[0]?.url).toBe('http://example.com');
  });

  it('没有 references → 空数组（生命周期闸会因此扣一分）', () => {
    const r = validateForgeSpec(base);
    expect(r.ok).toBe(true);
    expect(r.spec?.references).toEqual([]);
  });
});
