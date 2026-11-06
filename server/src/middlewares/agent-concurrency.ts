/**
 * Agent concurrency guard: at most AGENT_MAX_CONCURRENT (default 3) concurrent
 * /agent/stream tasks per IP. Excess requests get 429 AGENT_BUSY (retryable).
 *
 * AUDIT-021: the cap used to be read straight from `process.env` at module load
 * with `Number(process.env.AGENT_MAX_CONCURRENT ?? 3)`. That is the ONLY place
 * the value was consulted, and it bypassed the validated config — so a typo like
 * `AGENT_MAX_CONCURRENT='0'` made every request 429 forever, `'abc'` made
 * `Number()` return NaN (comparison always false → the guard never fired), and a
 * trailing space `'3 '` was accepted only by accident. The fix consumes the
 * zod-validated `config.maxConcurrentAgents` (int, clamped to 1..16, default 3),
 * so the guard can neither silently disable itself nor deadlock. The env knob
 * still works — it is just funnelled through validation at startup instead of a
 * bare coercion here.
 */

import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors.js';
import { config } from '../config/env.js';

const MAX_CONCURRENT = config.maxConcurrentAgents;
const activeByIp = new Map<string, number>();

function ipOf(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function agentConcurrency(req: Request, res: Response, next: NextFunction): void {
  const ip = ipOf(req);
  const active = activeByIp.get(ip) ?? 0;
  if (active >= MAX_CONCURRENT) {
    next(new AppError('AGENT_BUSY', '当前并发任务过多，请稍后重试', 429));
    return;
  }
  activeByIp.set(ip, active + 1);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const current = activeByIp.get(ip) ?? 1;
    if (current <= 1) activeByIp.delete(ip);
    else activeByIp.set(ip, current - 1);
  };
  res.on('finish', release);
  res.on('close', release);
  next();
}
