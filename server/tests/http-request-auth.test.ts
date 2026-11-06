/**
 * http.request — K-01 / AUDIT-002: authentication headers on the wire.
 *
 *   The handler used to run the *echo* de-sensitiser (`maskHeaders`) over the
 *   OUTBOUND request headers, so `Authorization` / `api-key` / `token` /
 *   `secret` / `password` / `cookie` were transmitted as the literal `***`.
 *   Every authenticated endpoint the tool touched answered 401, and nothing in
 *   the agent could explain why (the upstream error reads like a bad key, not
 *   like "we erased your header").
 *
 *   The fix is directional: outbound = verbatim, echo = masked. Both halves are
 *   asserted here so a future refactor cannot re-introduce either the 401 or
 *   the secret leak back into the LLM observation / SSE frame / preview.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** Set in beforeAll; read by the mocked SSRF guard when the handler calls it. */
let target: { url: URL; hostname: string; port: number } | undefined;

const received: Array<{ method: string; headers: http.IncomingHttpHeaders }> = [];

vi.mock('../src/utils/ssrf-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ssrf-guard.js')>();
  return {
    ...actual,
    // A real loopback server cannot be reached through the real guard (private
    // ranges are blocked by design), so the guard is the seam we stub. Everything
    // else in the module - isVerdictOk, MAX_REDIRECTS - stays real.
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
const { isVerdictOk } = await import('../src/utils/ssrf-guard.js');
import type { ToolExecutionContext } from '../src/types/tool.js';

let server: http.Server;

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
  server = http.createServer((req, res) => {
    received.push({ method: req.method ?? '', headers: req.headers });
    res.writeHead(200, {
      'content-type': 'application/json',
      // Sensitive response headers must NOT reach the LLM / SSE / preview raw.
      authorization: 'Bearer upstream-secret-should-be-masked',
      'set-cookie': 'session=steal-me; Path=/',
      'x-trace-id': 'trace-1234',
    });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  target = { url: new URL(`http://127.0.0.1:${addr.port}/probe`), hostname: '127.0.0.1', port: addr.port };
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe('http.request — outbound vs echo header handling (K-01)', () => {
  it('sends Authorization verbatim on the wire (regression: it used to go out as "***")', async () => {
    received.length = 0;
    const outcome = await httpRequestTool.handler(
      {
        url: target!.url.toString(),
        method: 'GET',
        headers: { Authorization: 'Bearer sk-live-abc123', 'X-Trace': 'trace-9' },
      },
      ctx(),
    );

    expect(outcome.ok).toBe(true);
    expect(received).toHaveLength(1);
    // The wire must carry the real credential, not the placeholder.
    expect(received[0]!.headers.authorization).toBe('Bearer sk-live-abc123');
    expect(received[0]!.headers['x-trace']).toBe('trace-9');
  });

  it('still masks sensitive headers on the echo path (observation / SSE / preview)', async () => {
    received.length = 0;
    const outcome = await httpRequestTool.handler(
      { url: target!.url.toString(), method: 'GET', headers: { Authorization: 'Bearer sk-live-abc123' } },
      ctx(),
    );

    const data = outcome.data as Record<string, unknown>;
    const echoed = data.headers as Record<string, string>;

    // Response secrets are de-sensitised before they reach the model.
    expect(echoed.authorization).toBe('***');
    // set-cookie is dropped outright, never echoed.
    expect(echoed['set-cookie']).toBeUndefined();
    // Non-sensitive response headers survive untouched.
    expect(echoed['x-trace-id']).toBe('trace-1234');
    expect(echoed['content-type']).toBe('application/json');
  });

  it('keeps other sensitive outbound headers verbatim, not just Authorization', async () => {
    received.length = 0;
    await httpRequestTool.handler(
      {
        url: target!.url.toString(),
        method: 'POST',
        headers: { 'X-Api-Key': 'key-live-1', Cookie: 'sid=abc', Token: 'tok-live-1' },
        body: '{}',
      },
      ctx(),
    );

    expect(received[0]!.headers['x-api-key']).toBe('key-live-1');
    expect(received[0]!.headers.cookie).toBe('sid=abc');
    expect(received[0]!.headers.token).toBe('tok-live-1');
  });

  it('leaves the SSRF guard verdict type intact (guard is stubbed, not bypassed in type)', () => {
    // isVerdictOk is the real export; guards the mock from silently widening.
    expect(isVerdictOk({ ok: true })).toBe(false);
  });
});
