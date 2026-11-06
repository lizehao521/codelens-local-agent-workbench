/**
 * Unified error shell (P2-13 / P2-11 regression net).
 *
 *   P2-13 — the SSE fallback frame (emitted when headers were already
 *           flushed) must satisfy the SseErrorPayload contract: the client
 *           reads `retryable` unconditionally on every error event, so the
 *           fallback path used to hand it `undefined`.
 *   P2-11 — body-parser failures get the unified JSON shell instead of
 *           Express's default HTML: oversized bodies 413, malformed JSON 400
 *           VALIDATION_ERROR. The 256kb limit keeps the spec-legal 32000-char
 *           message reachable by zod (21k CJK chars already pass 64kb).
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler, payloadTooLargeHandler, JSON_BODY_LIMIT } from '../src/middlewares/error-handler.js';
import { AppError, ErrorCode } from '../src/utils/errors.js';
import type { ErrorRequestHandler } from 'express';

interface FakeResponse {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  writableEnded: boolean;
  written: string[];
  status(code: number): FakeResponse;
  json(payload: unknown): FakeResponse;
  write(chunk: string): boolean;
  end(): FakeResponse;
}

function fakeRes(opts: { headersSent?: boolean } = {}): FakeResponse {
  const res: FakeResponse = {
    statusCode: 0,
    body: undefined,
    headersSent: opts.headersSent ?? false,
    writableEnded: false,
    written: [],
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    write(chunk: string) {
      res.written.push(chunk);
      return true;
    },
    end() {
      res.writableEnded = true;
      return res;
    },
  };
  return res;
}

/** Parses the SSE frames written by the fallback path. */
function frames(res: FakeResponse): Array<{ event: string; data: Record<string, unknown> }> {
  return res.written
    .join('')
    .split('\n\n')
    .filter((block) => block.includes('data: '))
    .map((block) => ({
      event: /^event:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? '',
      data: JSON.parse(/data:\s*(.+)$/m.exec(block)![1]) as Record<string, unknown>,
    }));
}

describe('error handler: unified shell + SSE fallback contract', () => {
  it('P2-13: the SSE fallback frame carries retryable (client reads it unconditionally)', () => {
    const res = fakeRes({ headersSent: true });
    errorHandler(new Error('boom'), {} as never, res as never, (() => {}) as never);

    const parsed = frames(res);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].event).toBe('error');
    expect(parsed[0].data).toMatchObject({ code: ErrorCode.INTERNAL_ERROR, retryable: false });
    expect(typeof parsed[0].data.message).toBe('string');
    expect(res.writableEnded).toBe(true);
  });

  it('JSON responses keep the { code, message } shell (no retryable leakage)', () => {
    const res = fakeRes();
    errorHandler(new AppError('RECOVERY_LOCKED', '已锁定', 423), {} as never, res as never, (() => {}) as never);

    expect(res.statusCode).toBe(423);
    expect(res.body).toEqual({ error: { code: 'RECOVERY_LOCKED', message: '已锁定' } });
  });

  it('ZodError → 400 VALIDATION_ERROR with the first issue path', () => {
    const schema = z.object({ message: z.string() });
    const parsed = schema.safeParse({ message: 42 });
    expect(parsed.success).toBe(false);
    const res = fakeRes();
    if (!parsed.success) {
      errorHandler(parsed.error, {} as never, res as never, (() => {}) as never);
    }

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect((res.body as { error: { message: string } }).error.message).toContain('message');
  });

  it('unknown errors log shape only: 500 INTERNAL_ERROR without the raw message', () => {
    const res = fakeRes();
    errorHandler(new Error('secret upstream payload'), {} as never, res as never, (() => {}) as never);

    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string; message: string } }).error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect((res.body as { error: { message: string } }).error.message).not.toContain('secret upstream payload');
  });
});

describe('payloadTooLargeHandler (P2-11)', () => {
  const tooLarge = { type: 'entity.too.large' } as Error;
  const badJson = { type: 'entity.parse.failed' } as Error;

  it('oversized body → 413 PAYLOAD_TOO_LARGE naming the real limit', () => {
    const res = fakeRes();
    payloadTooLargeHandler(tooLarge, {} as never, res as never, (() => {}) as never);

    expect(res.statusCode).toBe(413);
    expect((res.body as { error: { code: string } }).error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
    expect((res.body as { error: { message: string } }).error.message).toContain('256KB');
  });

  it('malformed JSON → 400 VALIDATION_ERROR (was Express default HTML 400)', () => {
    const res = fakeRes();
    payloadTooLargeHandler(badJson, {} as never, res as never, (() => {}) as never);

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('unrelated errors pass through to the next handler', () => {
    let passed = false;
    const next = ((): void => {
      passed = true;
    }) as ErrorRequestHandler;
    const res = fakeRes();
    payloadTooLargeHandler(new Error('other'), {} as never, res as never, next);

    expect(passed).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it('the shared limit constant is the raised 256kb', () => {
    expect(JSON_BODY_LIMIT).toBe('256kb');
  });
});
