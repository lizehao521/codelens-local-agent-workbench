/**
 * http.request — AUDIT-019: oversize response truncation classification.
 *
 *   超 CAP 时旧实现 `req.destroy()` 把「内容截断」误判成网络错误（ECONNRESET），
 *   落入 catch 被归 `retryable:true`，且 truncatedBytes 标志到不了 LLM。修复后：
 *   截断不是工具执行失败，而是结果标志 `truncatedBytes=true`（ADR-023：oversize
 *   results use tool_result.truncated；error-kind 枚举为锁定 10 值，不可新增）。
 *   本套件用一个真实 loopback 服务器（SSRF guard 被桩）流式回写超大响应，
 *   断言 handler 产出 ok:true + truncatedBytes:true + 无 error。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HTTP_RESPONSE_CAP } from '../src/tools/builtin/http-request.tool.js';
import type { ToolExecutionContext } from '../src/types/tool.js';

let target: { url: URL; hostname: string; port: number } | undefined;
let server: http.Server;

vi.mock('../src/utils/ssrf-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ssrf-guard.js')>();
  return {
    ...actual,
    validateTarget: async () => {
      if (!target) throw new Error('test server not started');
      return { ok: true, url: target.url, hostname: target.hostname, port: target.port, addresses: [target.hostname] };
    },
    validateRedirect: async () => {
      throw new Error('redirects are not exercised by this suite');
    },
  };
});

const { httpRequestTool } = await import('../src/tools/builtin/http-request.tool.js');

function ctx(): ToolExecutionContext {
  return {
    sessionId: 'sess_test',
    toolCallId: 'tc_test',
    callId: 'call_test',
    iteration: 1,
    sandboxRoot: '.',
    signal: new AbortController().signal,
    reportProgress: () => undefined,
  };
}

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    // 吞掉客户端截断后提前销毁连接导致的 EPIPE——测试服务器不应因此崩溃。
    res.on('error', () => undefined);
    // 一次写入 CAP+1KB；客户端会在超过 CAP 时截断并销毁连接。
    res.end(Buffer.alloc(HTTP_RESPONSE_CAP + 1024, 0x61));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  target = { url: new URL(`http://127.0.0.1:${addr.port}/big`), hostname: '127.0.0.1', port: addr.port };
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe('http.request — AUDIT-019 超大响应截断分类', () => {
  it('超大响应 → ok:true + truncatedBytes:true，无 error（标志送达而非网络错误）', async () => {
    const outcome = await httpRequestTool.handler({ url: target!.url.toString(), method: 'GET' }, ctx());

    expect(outcome.ok).toBe(true);
    expect(outcome.error).toBeUndefined();

    const data = outcome.data as { status: number; bytes: number; truncatedBytes: boolean; body: string };
    expect(data.status).toBe(200);
    expect(data.truncatedBytes).toBe(true);
    expect(data.bytes).toBeLessThanOrEqual(HTTP_RESPONSE_CAP);
    // 预览被裁剪到 4000 字符以内，防止 LLM 上下文被原始大响应撑爆。
    expect(data.body.length).toBeLessThanOrEqual(4000);
  });
});