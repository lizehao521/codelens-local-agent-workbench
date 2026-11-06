/** Approval endpoint validation (spec 3.3.12 / 3.3.13). */

import { z } from 'zod';

/**
 * Decision endpoint: STRICT three keys. `arguments` / `toolName` / `args` in the
 * body are rejected with 400 — the client only ever submits a decision.
 */
export const ApprovalDecisionSchema = z
  .object({
    token: z.string().min(1).max(512),
    decision: z.enum(['allow_once', 'allow_session', 'reject']),
    reason: z.string().max(500).optional(),
  })
  .strict();

/**
 * Revise endpoint (AC-10, independent endpoint): the ONLY endpoint that accepts
 * `arguments`. Still strict — unknown keys (toolName/decision/callId) are 400.
 */
export const ApprovalReviseSchema = z
  .object({
    token: z.string().min(1).max(512),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

export const ApprovalIdParamSchema = z.object({
  id: z.string().min(1).max(128),
});

/**
 * Re-issue endpoint (AUDIT-009): the ONLY other endpoint that accepts the raw
 * token. STRICT — only `token` is allowed; a decision or arguments here is 400.
 */
export const ApprovalReissueSchema = z
  .object({
    token: z.string().min(1).max(512),
  })
  .strict();
