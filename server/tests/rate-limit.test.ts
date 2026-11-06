import { describe, expect, it, beforeEach } from 'vitest';
import { rateLimit, resetRateLimits, RateLimiter } from '../src/middlewares/rate-limit.js';
import { ErrorCode } from '../src/utils/errors.js';
import type { NextFunction, Request, Response } from 'express';

function fakeReqRes() {
  const req = { ip: '203.0.113.7', socket: { remoteAddress: '203.0.113.7' } } as unknown as Request;
  const res = {} as Response;
  return { req, res };
}

describe('rateLimit middleware', () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it('allows requests within the limit', () => {
    const middleware = rateLimit(3, 'test-route');
    const { req, res } = fakeReqRes();
    for (let i = 0; i < 3; i += 1) {
      let error: unknown;
      const next: NextFunction = (err?: unknown) => {
        error = err;
      };
      middleware(req, res, next);
      expect(error).toBeUndefined();
    }
  });

  it('returns 429 RATE_LIMITED when the limit is exceeded', () => {
    const middleware = rateLimit(2, 'test-route');
    const { req, res } = fakeReqRes();
    let lastError: unknown;
    for (let i = 0; i < 5; i += 1) {
      const next: NextFunction = (err?: unknown) => {
        lastError = err;
      };
      middleware(req, res, next);
    }
    expect(lastError).toBeDefined();
    expect((lastError as { code: string }).code).toBe(ErrorCode.RATE_LIMITED);
    expect((lastError as { status: number }).status).toBe(429);
  });

  it('tracks counters per route independently', () => {
    const chatLimit = rateLimit(2, 'chat');
    const streamLimit = rateLimit(1, 'stream');
    const { req, res } = fakeReqRes();

    const okNext: NextFunction = (err?: unknown) => {
      expect(err).toBeUndefined();
    };
    chatLimit(req, res, okNext);
    chatLimit(req, res, okNext); // chat budget of 2 now exhausted

    let chatErr: unknown;
    const chatNext: NextFunction = (err?: unknown) => {
      chatErr = err;
    };
    chatLimit(req, res, chatNext);
    expect((chatErr as { code: string }).code).toBe(ErrorCode.RATE_LIMITED);

    // stream has its own counter and is unaffected by the chat budget.
    let streamErr: unknown;
    const streamNext: NextFunction = (err?: unknown) => {
      streamErr = err;
    };
    streamLimit(req, res, streamNext);
    expect(streamErr).toBeUndefined();
  });

  it('tracks counters per IP independently', () => {
    const middleware = rateLimit(1, 'chat');
    const first = fakeReqRes();
    const second = {
      req: { ip: '198.51.100.9', socket: { remoteAddress: '198.51.100.9' } } as unknown as Request,
      res: {} as Response,
    };

    let firstErr: unknown;
    middleware(first.req, first.res, (err?: unknown) => {
      firstErr = err;
    });
    expect(firstErr).toBeUndefined();

    let secondErr: unknown;
    middleware(second.req, second.res, (err?: unknown) => {
      secondErr = err;
    });
    expect(secondErr).toBeUndefined();
  });
});

describe('AUDIT-022: bounded eviction when the key map is full', () => {
  it('does NOT wipe every counter when a new key arrives at capacity', () => {
    // A tiny cap makes the overflow deterministically testable without 100k keys.
    const limiter = new RateLimiter({ maxTrackedKeys: 3, startCleanup: false });
    limiter.takeSlot('k1');
    limiter.takeSlot('k2');
    limiter.takeSlot('k3');
    expect(limiter.currentCount('k1')).toBe(1);
    expect(limiter.currentCount('k2')).toBe(1);
    expect(limiter.currentCount('k3')).toBe(1);

    // The 4th distinct key pushes the map to capacity → the OLD code did
    // `buckets.clear()` here, zeroing k1/k2/k3. The new code evicts only the
    // single most-stale bucket to make room.
    limiter.takeSlot('k4');

    // At least two of the original counters survive (no global reset).
    const survivors = ['k1', 'k2', 'k3'].filter((k) => limiter.currentCount(k) === 1);
    expect(survivors.length).toBeGreaterThanOrEqual(2);
    // The new key still gets its own slot.
    expect(limiter.currentCount('k4')).toBe(1);
  });
});
