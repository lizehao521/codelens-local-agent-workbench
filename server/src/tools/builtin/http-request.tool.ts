/**
 * http.request — external HTTP/HTTPS with the five-fold SSRF guard
 * (spec 7.6.1): protocol allowlist → credential rejection → DNS-resolve-then-check
 * every record → connect to the validated IP only (no TOCTOU rebind) → per-hop
 * revalidation on manual redirects. Response bodies are byte-capped.
 */

import http from 'node:http';
import https from 'node:https';
import type { ToolDefinition } from '../../types/tool.js';
import {
  MAX_REDIRECTS,
  isVerdictOk,
  validateRedirect,
  validateTarget,
  type UrlVerdictOk,
} from '../../utils/ssrf-guard.js';

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const SENSITIVE_HEADER_RE = /^(api-?key|token|secret|password|authorization|cookie)$/i;
const DEFAULT_TIMEOUT_MS = 30000;

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncatedBytes: boolean;
}

function maskHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_RE.test(key)) out[key] = '***';
    else if (typeof value === 'string' || typeof value === 'number') out[key] = String(value);
  }
  return out;
}

function singleRequest(
  verdict: UrlVerdictOk,
  method: string,
  headers: Record<string, string>,
  body: string | null,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<RawResponse> {
  const url = verdict.url;
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const address = verdict.addresses[0]!;

  return new Promise<RawResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncatedBytes = false;
    let settled = false;

    const buildHeaders = (res: http.IncomingMessage): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) out[key] = value.join(', ');
        else if (value !== undefined) out[key] = value;
      }
      delete out['set-cookie']; // never leak cookies
      return out;
    };

    const finish = (res: http.IncomingMessage): void => {
      if (settled) return;
      settled = true;
      resolve({ status: res.statusCode ?? 0, headers: buildHeaders(res), body: Buffer.concat(chunks), truncatedBytes });
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method,
        headers: { ...headers, host: url.host },
        // Pin the connection to the address validated by the SSRF guard.
        lookup: (_hostname, _options, callback) => {
          callback(null, address, url.hostname.includes(':') ? 6 : 4);
        },
      },
      (res) => {
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          total += chunk.byteLength;
          if (total > HTTP_RESPONSE_CAP) {
            // AUDIT-019：超上限不再 req.destroy() 抛成「网络错误」，而是立即以已收
            // 字节结算（truncatedBytes=true），让截断标志作为结果送达 LLM 而非误报重试。
            truncatedBytes = true;
            finish(res);
            req.destroy(); // 停掉后续下载；settled 已挡住 destroy 触发的后续事件
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish(res));
        res.on('error', fail);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('TIMEOUT')));
    signal.addEventListener('abort', () => req.destroy(new Error('ABORTED')), { once: true });
    req.on('error', fail);
    if (body !== null) req.write(body);
    req.end();
  });
}

export const HTTP_RESPONSE_CAP = 4_000_000; // hard cap on collected bytes; truncation flags the result

export const httpRequestTool: ToolDefinition = {
  name: 'http.request',
  wireName: 'http_request',
  displayName: 'HTTP 请求',
  category: 'http',
  description:
    '向外部 HTTP/HTTPS 服务发起请求（默认仅 https）。GET/HEAD 直接执行；POST/PUT/PATCH/DELETE 需要用户确认。重定向逐跳校验（≤3 跳），响应体截断到上限，不回传 set-cookie。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '目标 URL（http/https）', maxLength: 2048 },
      method: { type: 'string', enum: [...METHODS], description: 'HTTP 方法，缺省 GET' },
      headers: { type: 'object', description: '请求头（键值均为字符串）', additionalProperties: { type: 'string' } },
      body: { type: 'string', description: '请求体（字符串）', maxLength: 1000000 },
      timeoutMs: { type: 'number', description: '超时毫秒，≤30000，缺省 10000', minimum: 1, maximum: 30000 },
    },
    required: ['url'],
    additionalProperties: false,
  },
  timeoutMs: 30000,
  risk: 'low',
  approvalMode: 'none',
  source: 'builtin',
  idempotent: false,
  maxResultChars: 4000,
  enabled: () => true,
  handler: async (args, ctx) => {
    const method = args.method === undefined ? 'GET' : String(args.method).toUpperCase();
    if (!METHODS.includes(method as (typeof METHODS)[number])) {
      return {
        ok: false,
        summary: `method 必须是 ${METHODS.join('/')}`,
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: `method 必须是 ${METHODS.join('/')}` },
      };
    }
    const timeoutMs = args.timeoutMs === undefined ? 10000 : Number(args.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
      return {
        ok: false,
        summary: 'timeoutMs 必须是 1-30000 的整数',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'timeoutMs 必须是 1-30000 的整数' },
      };
    }
    const rawHeaders = args.headers === undefined ? {} : args.headers;
    if (typeof rawHeaders !== 'object' || rawHeaders === null || Array.isArray(rawHeaders)) {
      return {
        ok: false,
        summary: 'headers 必须是对象',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'headers 必须是对象' },
      };
    }
    for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value !== 'string' && typeof value !== 'number') {
        return {
          ok: false,
          summary: `请求头 ${key} 的值必须是字符串`,
          error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: `请求头 ${key} 的值必须是字符串` },
        };
      }
    }
    // Outbound headers go out VERBATIM. `maskHeaders` used to sit here, which
    // rewrote Authorization / api-key / token / secret / password / cookie to
    // '***' on the wire — every authenticated request the tool made came back
    // 401, and nothing in the agent could tell why (the upstream error looks
    // like a bad key, not like "we erased your header"). Masking is a display
    // concern for echoes, never for the request we send.
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      headers[key] = String(value);
    }
    const body = args.body === undefined ? null : String(args.body);

    const target = await validateTarget(String(args.url ?? ''));
    if (!isVerdictOk(target)) {
      return {
        ok: false,
        summary: target.message ?? '目标被安全策略拒绝',
        error: {
          code: 'TOOL_SECURITY_DENIED',
          kind: 'security',
          message: target.message ?? '目标被安全策略拒绝',
          retryable: false,
        },
      };
    }
    // Explicit type: the loop reassigns verdict per redirect hop, and control-flow
    // narrowing does not survive that back edge.
    let verdict: UrlVerdictOk = target;

    ctx.reportProgress('connecting', `请求 ${verdict.hostname}`);
    let hops = 0;
    let currentMethod = method;
    let currentBody = body;
    let currentHeaders = headers;
    let last: RawResponse | undefined;

    for (;;) {
      try {
        last = await singleRequest(verdict, currentMethod, currentHeaders, currentBody, timeoutMs, ctx.signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'ABORTED') throw err;
        if (message === 'TIMEOUT') {
          return {
            ok: false,
            summary: `目标在 ${timeoutMs}ms 内未响应`,
            error: {
              code: 'TOOL_TIMEOUT',
              kind: 'timeout',
              message: `目标服务在 ${timeoutMs}ms 内未返回响应`,
              suggestion: '该目标近期不稳定，可重试或改用备选接口',
              retryable: true,
            },
          };
        }
        return {
          ok: false,
          summary: `网络错误：${message}`,
          error: {
            code: 'TOOL_NETWORK',
            kind: 'network',
            message: `无法连接 ${verdict.hostname}：${message}`,
            retryable: true,
          },
        };
      }

      const location = last.headers['location'];
      const isRedirect = last.status >= 300 && last.status < 400 && location !== undefined;
      if (!isRedirect) break;
      if (hops >= MAX_REDIRECTS) {
        return {
          ok: false,
          summary: `重定向超过 ${MAX_REDIRECTS} 跳`,
          error: {
            code: 'TOOL_UPSTREAM',
            kind: 'upstream',
            message: `重定向链超过 ${MAX_REDIRECTS} 跳上限`,
            retryable: false,
          },
        };
      }
      hops += 1;
      const nextVerdict = await validateRedirect(location, verdict.url);
      if (!isVerdictOk(nextVerdict)) {
        return {
          ok: false,
          summary: nextVerdict.message ?? '重定向目标被安全策略拒绝',
          error: {
            code: 'TOOL_SECURITY_DENIED',
            kind: 'security',
            message: nextVerdict.message ?? '重定向目标被安全策略拒绝',
            retryable: false,
          },
        };
      }
      // 303 (and 301/302 for POST) switch to GET and drop the body per RFC 9110.
      if (last.status === 303 || ((last.status === 301 || last.status === 302) && currentMethod !== 'HEAD')) {
        currentMethod = currentMethod === 'HEAD' ? 'HEAD' : 'GET';
        currentBody = null;
        currentHeaders = Object.fromEntries(
          Object.entries(currentHeaders).filter(([key]) => !['content-type', 'content-length'].includes(key.toLowerCase())),
        );
      }
      verdict = nextVerdict;
      ctx.reportProgress('redirecting', `跟随重定向到 ${verdict.hostname}`);
    }

    const contentType = last!.headers['content-type'] ?? '';
    const text = last!.body.toString('utf8');
    const isJson = contentType.includes('json') || /^\s*[[{]/.test(text);
    let data: Record<string, unknown> = {
      status: last!.status,
      // K-01 (echo half): response headers are de-sensitised here - this object
      // becomes the LLM observation, the tool_result SSE frame and the persisted
      // inline preview. Outbound request headers are NOT masked (see above).
      headers: maskHeaders(last!.headers),
      contentType,
      bytes: last!.body.byteLength,
      truncatedBytes: last!.truncatedBytes,
      body: text.slice(0, last!.truncatedBytes ? 4000 : 1_000_000),
    };
    if (isJson) {
      try {
        data = { ...data, json: JSON.parse(text) };
      } catch {
        // keep raw text when JSON.parse fails
      }
    }
    const ok = last!.status >= 200 && last!.status < 400;
    return {
      ok,
      summary: `${currentMethod} ${verdict.hostname} → HTTP ${last!.status}（${last!.body.byteLength} 字节${last!.truncatedBytes ? '，已截断' : ''}）`,
      data,
      error: ok
        ? undefined
        : {
            code: last!.status === 429 ? 'TOOL_RATE_LIMITED' : 'TOOL_UPSTREAM',
            kind: last!.status === 429 ? ('rate_limit' as const) : ('upstream' as const),
            message: `上游返回 HTTP ${last!.status}`,
            suggestion:
              last!.status === 429
                ? '上游限流，稍后重试'
                : last!.status >= 500
                  ? '上游服务错误，可重试'
                  : '检查请求参数与鉴权信息',
            retryable: last!.status === 429 || last!.status >= 500,
          },
    };
  },
};
