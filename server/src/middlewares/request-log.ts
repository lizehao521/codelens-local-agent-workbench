/** Minimal request logging: method/path/status/duration only. Never logs body, headers, or keys. */

import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/env.js';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  if (config.nodeEnv === 'test') {
    next();
    return;
  }
  const startedAt = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const line = `${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`;
    // eslint-disable-next-line no-console
    console.log(line);
  });
  next();
}
