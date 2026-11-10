/**
 * web.search —— Agent 的联网检索能力（造工具前的「外部依据」来源）。
 *
 * 为什么需要它：能力沉淀不该只靠模型内部知识。读本 §6 第 2 步要求「先改现有工具，
 * 再考虑新写」，而判断「别人怎么做」需要外部证据。检索结果同时作为
 * tool.forge 的 references：没有依据的自造工具会被生命周期闸扣分。
 *
 * 实现取 Bing 的 RSS 输出（`&format=rss`）：
 *   - 免密钥、结构稳定（标准 RSS 2.0），不需要解析整页 HTML；
 *   - 结果条数少而精，正好够「找一两个可借鉴的做法」。
 *
 * 代理：Node 的 fetch 不读 HTTP(S)_PROXY，必须显式给 ProxyAgent，
 * 否则在受限网络里会直接失败（实测 curl 能通、裸 fetch 不能）。
 */

import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { ToolDefinition, ToolOutcome } from '../../types/tool.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 解析 RSS：只取 item 的 title/link/description，去标签、压空白。 */
export function parseBingRss(xml: string, limit = 5): SearchResult[] {
  const out: SearchResult[] = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  for (const raw of items) {
    const title = pick(raw, 'title');
    const url = pick(raw, 'link');
    const snippet = pick(raw, 'description');
    if (!title || !url) continue;
    out.push({ title, url, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

function pick(raw: string, tag: string): string {
  const m = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) return '';
  // 先解实体再去标签：RSS 里的摘要常写成 `&lt;b&gt;关键词&lt;/b&gt;`，
  // 顺序反了会把实体解码出来的标签当正文留下来（实测踩过）。
  return decodeEntities(m[1]!).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 每次调用新建 dispatcher：代理配置可能随环境变化，缓存会拿住过期配置。 */
function dispatcher(): Dispatcher | undefined {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  return proxy ? new ProxyAgent(proxy) : undefined;
}

export const webSearchTool: ToolDefinition = {
  name: 'web.search',
  wireName: 'web_search',
  displayName: '联网检索',
  category: 'http',
  description:
    '联网检索公开资料，返回前 5 条结果的标题、链接与摘要。用于给「造新工具」找外部依据：先查别人怎么做，再决定是否值得造。只读，不改任何文件。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索词（自然语言或关键词均可）', maxLength: 200 },
      limit: { type: 'number', description: '返回条数，默认 5，上限 8', minimum: 1, maximum: 8 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  timeoutMs: 25000,
  risk: 'low',
  approvalMode: 'none',
  source: 'builtin',
  idempotent: true,
  maxResultChars: 4000,
  enabled: () => true,

  handler: async (args): Promise<ToolOutcome> => {
    const query = String(args.query ?? '').trim();
    if (query.length < 2) {
      return {
        ok: false,
        summary: 'query 至少 2 个字',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'query 过短' },
      };
    }
    const limit = Math.min(8, Math.max(1, Number(args.limit ?? 5) || 5));
    // mkt/setlang：Bing 的 RSS 会按地区返回本地化结果，默认中文市场下
    // 技术查询常被词典/百科页占满（实测），显式指定英文市场后相关性明显更好。
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&mkt=en-US&setlang=en&cc=US`;

    try {
      const res = await undiciFetch(url, {
        dispatcher: dispatcher(),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CodeLens-Agent/1.0)', Accept: 'application/rss+xml,text/xml' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        return {
          ok: false,
          summary: `检索服务返回 HTTP ${res.status}`,
          error: { code: 'TOOL_UPSTREAM_ERROR', kind: 'upstream', message: `HTTP ${res.status}`, retryable: true },
        };
      }
      const results = parseBingRss(await res.text(), limit);
      if (results.length === 0) {
        return { ok: true, summary: `「${query}」没有检索到结果`, data: { query, results: [] } };
      }
      return {
        ok: true,
        summary: `「${query}」命中 ${results.length} 条：${results.map((r) => r.title).join(' / ')}`.slice(0, 900),
        data: { query, results },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `检索失败：${message}`,
        error: { code: 'TOOL_NETWORK_ERROR', kind: 'network', message, retryable: true },
      };
    }
  },
};
