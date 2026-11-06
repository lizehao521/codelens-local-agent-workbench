/** SSE writing helpers. Server side only; the browser client lives in client/. */

import type { Response } from 'express';
import type { SseEventName } from '../types/index.js';

const HEARTBEAT_MS = 15000;

/** Set the headers required for an SSE stream. */
export function setSSEHeaders(res: Response): void {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

/** Write one SSE frame: `event: <name>` + `data: <json>` + blank line. */
export function sendSSEEvent(res: Response, event: SseEventName, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Start a periodic heartbeat to keep proxies from closing idle streams.
 * Returns a stop function; call it when the stream ends.
 */
export function startSSEHeartbeat(res: Response): () => void {
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** End the SSE stream. */
export function endSSE(res: Response): void {
  if (!res.writableEnded) res.end();
}
