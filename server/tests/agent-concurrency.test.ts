/**
 * Agent concurrency guard (AUDIT-021): the cap now comes from the zod-validated
 * `config.maxConcurrentAgents` instead of a bare `Number(process.env...)`. The
 * env knob still applies, but it can no longer collapse to NaN (guard never
 * fires) or 0 (everything 429s forever). This test pins the live behaviour with
 * the default cap of 3: a 4th simultaneous request from the same IP is rejected.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { agentConcurrency } from '../src/middlewares/agent-concurrency.js';
import { ErrorCode } from '../src/utils/errors.js';
import type { NextFunction, Request } from 'express';

function makeReqRes(ip: string): { req: Request; res: EventEmitter } {
  const req = { ip, socket: { remoteAddress: ip } } as unknown as Request;
  const res = new EventEmitter() as EventEmitter & { json?: unknown };
  return { req, res };
}

const released: Array<EventEmitter> = [];

describe('AUDIT-021 agentConcurrency', () => {
  afterEach(() => {
    for (const r of released.splice(0)) r.emit('finish');
  });

  it('rejects the 4th concurrent request from the same IP at the default cap of 3', () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 1000)}`;
    let lastError: unknown;
    for (let i = 0; i < 4; i += 1) {
      const { req, res } = makeReqRes(ip);
      released.push(res);
      let err: unknown;
      const next: NextFunction = (e?: unknown) => {
        err = e;
      };
      agentConcurrency(req, res as any, next);
      if (i === 3) lastError = err;
    }
    expect((lastError as { code?: string })?.code).toBe(ErrorCode.AGENT_BUSY);
    expect((lastError as { status?: number })?.status).toBe(429);
  });

  it('allows distinct IPs to each hold up to the cap independently', () => {
    const ipA = `198.51.100.${Math.floor(Math.random() * 1000)}`;
    const ipB = `198.51.100.${Math.floor(Math.random() * 1000)}`;
    let errA: unknown;
    let errB: unknown;
    for (let i = 0; i < 3; i += 1) {
      const a = makeReqRes(ipA);
      released.push(a.res);
      agentConcurrency(a.req, a.res as any, (e?: unknown) => { errA = e; });
      const b = makeReqRes(ipB);
      released.push(b.res);
      agentConcurrency(b.req, b.res as any, (e?: unknown) => { errB = e; });
    }
    expect(errA).toBeUndefined();
    expect(errB).toBeUndefined();
  });
});
