/** Unified error handler: { "error": { code, message } }. Never leaks apiKey or upstream bodies. */

import type { ErrorRequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, ErrorCode, isAppError } from '../utils/errors.js';
import type { SseErrorPayload } from '../types/agent-events.js';

interface ErrorBody {
  error: { code: string; message: string };
}

function sendError(res: Response, status: number, code: string, message: string): void {
  if (res.headersSent) {
    // Headers already flushed (SSE stream): emit an SSE error frame instead.
    if (!res.writableEnded) {
      // P2-13: the fallback frame must satisfy the SseErrorPayload contract
      // (types/agent-events.ts) — the client reads `retryable` unconditionally
      // on every error event, so an unexpected error must still carry it.
      // Unexpected failures are never safe to retry blindly.
      const frame: SseErrorPayload = { code, message, retryable: false };
      res.write(`event: error\ndata: ${JSON.stringify(frame)}\n\n`);
      res.end();
    }
    return;
  }
  const body: ErrorBody = { error: { code, message } };
  res.status(status).json(body);
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    sendError(res, 400, ErrorCode.VALIDATION_ERROR, `请求参数校验失败: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim());
    return;
  }
  if (isAppError(err)) {
    sendError(res, err.status, err.code, err.message);
    return;
  }
  // Unknown error: log shape only, never the raw error (may contain upstream payloads/keys).
  const name = err instanceof Error ? err.name : 'UnknownError';
  sendError(res, 500, ErrorCode.INTERNAL_ERROR, `服务内部错误 (${name})`);
};

/**
 * Shared with app.ts so the body limit and the 413 message cannot drift apart.
 * Raised from 64kb (P2-11): AgentRequestSchema allows `message` up to 32000
 * chars, and 21k CJK chars already UTF-8-encode past 64KB — the old limit
 * rejected spec-legal payloads with a raw 413 before zod ever saw them.
 */
export const JSON_BODY_LIMIT = '256kb';

/** body-parser failures -> unified JSON shell instead of Express's default HTML. */
export const payloadTooLargeHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (err && typeof err === 'object' && 'type' in err) {
    const type = (err as { type?: string }).type;
    if (type === 'entity.too.large') {
      sendError(res, 413, ErrorCode.PAYLOAD_TOO_LARGE, `请求体超过大小限制（最大 ${JSON_BODY_LIMIT.toUpperCase()}）`);
      return;
    }
    // P2-11: malformed JSON used to surface as Express's default HTML 400.
    // The spec promises one application/json error shell, so translate it.
    if (type === 'entity.parse.failed') {
      sendError(res, 400, ErrorCode.VALIDATION_ERROR, '请求体不是合法的 JSON');
      return;
    }
  }
  next(err);
};
