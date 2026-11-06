/** 404 handling: JSON for /api/*; other paths fall through to the SPA fallback in app.ts. */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, ErrorCode } from '../utils/errors.js';

export const notFoundHandler: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/')) {
    next(new AppError(ErrorCode.NOT_FOUND, `接口不存在: ${req.method} ${req.path}`));
    return;
  }
  // Non-API path: GET/HEAD are served by the SPA fallback registered later.
  // P2-12: anything else (POST/PUT/DELETE on a non-API path) has no handler at
  // all — it used to fall through to Express's default HTML 404, breaking the
  // spec's "unified application/json error shell". Answer in JSON here.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next(new AppError(ErrorCode.NOT_FOUND, `路径不存在: ${req.method} ${req.path}`));
    return;
  }
  next();
};
