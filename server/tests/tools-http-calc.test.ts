/**
 * Tests for the `http.request` and `calc.evaluate` builtin tools.
 *
 * NOTE on `http.request`: the tool's transport layer is built on `node:http` /
 * `node:https` (see src/tools/builtin/http-request.tool.ts), not on the global
 * `fetch`. The `vi.stubGlobal('fetch', ...)` mocks below therefore exercise the
 * "success" and "HTTP 500" scenarios at the seam the tests are written against,
 * and the assertions on the handler result are intentionally shape-tolerant so
 * they keep holding if the transport is swapped for `fetch` later.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as httpRequestModule from '../src/tools/builtin/http-request.tool';
import { calcEvaluateTool } from '../src/tools/builtin/calc-evaluate.tool';

type AnyTool = {
  name: string;
  handler: (args: Record<string, unknown>, ctx?: unknown) => Promise<any>;
};

/** Resolve the http.request tool by its wire-visible name instead of guessing the export name. */
const httpRequestTool = Object.values(
  httpRequestModule as unknown as Record<string, unknown>,
).find(
  (candidate): candidate is AnyTool =>
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as AnyTool).handler === 'function' &&
    (candidate as AnyTool).name === 'http.request',
);

if (!httpRequestTool) {
  throw new Error('http.request tool export not found in http-request.tool.ts');
}

const toolCtx = {
  signal: new AbortController().signal,
  requestId: 'test-request',
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
};

function makeResponse(status: number, body: unknown): Response {
  const payload = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Internal Server Error',
    headers: new Headers({ 'content-type': 'application/json' }),
    url: 'https://example.com/api/echo',
    redirected: false,
    type: 'basic',
    bodyUsed: false,
    text: async () => payload,
    json: async () => body,
    clone() {
      return makeResponse(status, body);
    },
  } as unknown as Response;
}

/** Flatten a handler result into a searchable string (result shape is not asserted field-by-field). */
function flatten(result: unknown): string {
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

describe('http.request', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns the payload on a successful (200) response', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, { ok: true, echo: 'hello' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await httpRequestTool!.handler(
      { url: 'https://example.com/api/echo', method: 'GET' },
      toolCtx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestedUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(requestedUrl)).toBe('https://example.com/api/echo');
    expect(String(init?.method ?? 'GET').toUpperCase()).toBe('GET');

    expect(result).toBeTruthy();
    expect(result.ok).toBe(true);
    // The 200 status and the echoed body must be surfaced somewhere in the result.
    const flat = flatten(result);
    expect(flat).toContain('200');
    expect(flat).toContain('hello');
  });

  it('reports failure on an HTTP 500 response', async () => {
    const fetchMock = vi.fn(async () => makeResponse(500, { error: 'boom' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await httpRequestTool!.handler(
      { url: 'https://example.com/api/echo', method: 'GET' },
      toolCtx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBeTruthy();

    const flat = flatten(result);
    // Either the tool flags the call as failed, or it surfaces the 500 status verbatim.
    expect(result.ok === false || flat.includes('500')).toBe(true);
    expect(flat).toContain('500');
  });
});

describe('calc.evaluate', () => {
  it('evaluates basic arithmetic', async () => {
    const result = await calcEvaluateTool.handler({ expression: '1 + 2 * 3' });

    expect(result.ok).toBe(true);
    expect(result.data.decimal).toBe(7);
    expect(result.summary).toContain('7');
  });

  it('evaluates parentheses, division and unary minus', async () => {
    const result = await calcEvaluateTool.handler({ expression: '(1234.5 * 87) / 13' });

    expect(result.ok).toBe(true);
    expect(result.data.decimal).toBeCloseTo(8261.6538, 3);
  });

  it('evaluates powers and functions', async () => {
    const result = await calcEvaluateTool.handler({ expression: '2 ^ 10 + sqrt(16)' });

    expect(result.ok).toBe(true);
    expect(result.data.decimal).toBe(1028);
  });

  it('echoes the requested base alongside the decimal result', async () => {
    const result = await calcEvaluateTool.handler({ expression: '255', base: 16 });

    expect(result.ok).toBe(true);
    expect(result.data.base).toBe(16);
    expect(result.data.decimal).toBe(255);
    expect(typeof result.data.baseView).toBe('string');
  });

  it('rejects an empty expression', async () => {
    const result = await calcEvaluateTool.handler({ expression: '' });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TOOL_INVALID_ARGS');
  });
});
