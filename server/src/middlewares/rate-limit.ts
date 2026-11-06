/** In-memory sliding-window rate limiter keyed by client IP (spec section 5, architecture 4.3). */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, ErrorCode } from '../utils/errors.js';

interface Bucket {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_TRACKED_KEYS = 100_000;

function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export interface RateLimiterOptions {
  /** Hard cap on distinct tracked keys before eviction kicks in. */
  maxTrackedKeys?: number;
  /** Sliding-window duration in ms. */
  windowMs?: number;
  /** Start the background expiry sweep (default: true). Tests pass false. */
  startCleanup?: boolean;
}

/**
 * Per-instance limiter. Extracted from the previous module-level map so the
 * eviction policy is unit-testable with a tiny `maxTrackedKeys`.
 *
 * AUDIT-022: the old `takeSlot` wiped the ENTIRE bucket map the moment the key
 * count hit 100k (`buckets.clear()`). An attacker spraying 100k distinct IPs
 * could reset every legitimate caller's counter to zero in one shot — a
 * self-inflicted DoS with a single request. Eviction is now BOUNDED: expired
 * buckets are reclaimed first, and only if still full is the single most-stale
 * bucket dropped to make room for the new key. Nobody else loses their counter.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxTrackedKeys: number;
  private readonly windowMs: number;
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(opts: RateLimiterOptions = {}) {
    this.maxTrackedKeys = opts.maxTrackedKeys ?? MAX_TRACKED_KEYS;
    this.windowMs = opts.windowMs ?? WINDOW_MS;
    if (opts.startCleanup !== false) this.startCleanupTimer();
  }

  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets) {
        if (bucket.resetAt <= now) this.buckets.delete(key);
      }
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  /** Records one hit for `key`; returns false if the budget is now exceeded. */
  takeSlot(key: string, now: number = Date.now()): void {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      // Make room WITHOUT wiping the map: reclaim expired entries first, then —
      // only if still at capacity — drop the single most-stale bucket. The new
      // key always gets a fresh slot; everyone else keeps their counter.
      if (this.buckets.size >= this.maxTrackedKeys) {
        this.evictExpired(now);
        if (this.buckets.size >= this.maxTrackedKeys) this.evictOldest();
      }
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    bucket.count += 1;
  }

  /** Current hit count for `key` (0 if absent or expired). */
  currentCount(key: string, now: number = Date.now()): number {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) return 0;
    return bucket.count;
  }

  /** Test helper: drop all in-memory counters. */
  reset(): void {
    this.buckets.clear();
  }

  private evictExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt < oldestAt) {
        oldestAt = bucket.resetAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.buckets.delete(oldestKey);
  }
}

const defaultLimiter = new RateLimiter();

/** Build a rate-limit middleware for a fixed requests-per-minute budget. */
export function rateLimit(limit: number, routeName: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = `${routeName}:${clientKey(req)}`;
    defaultLimiter.takeSlot(key);
    if (defaultLimiter.currentCount(key) > limit) {
      next(new AppError(ErrorCode.RATE_LIMITED, '请求过于频繁，请稍后再试'));
      return;
    }
    next();
  };
}

/** Test helper: drop all in-memory counters on the default limiter. */
export function resetRateLimits(): void {
  defaultLimiter.reset();
}
