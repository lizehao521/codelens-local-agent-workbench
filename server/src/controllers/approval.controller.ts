/**
 * Approval controller: POST /api/v1/approvals/:id (decision) and
 * POST /api/v1/approvals/:id/revise (AC-10 parameter revision).
 * Both are JSON endpoints — the tool result itself flows on the original SSE stream.
 */

import type { Request, Response } from 'express';
import { AppError } from '../utils/errors.js';
import type { ApprovalService } from '../services/agent/approval.service.js';
import { ApprovalDecisionSchema, ApprovalReviseSchema, ApprovalReissueSchema, ApprovalIdParamSchema } from '../validators/approval.schema.js';

export class ApprovalController {
  constructor(private readonly approvals: ApprovalService) {}

  decide(req: Request, res: Response): void {
    const params = ApprovalIdParamSchema.safeParse(req.params);
    if (!params.success) throw new AppError('VALIDATION_ERROR', 'approvalId 不合法', 400);
    const parsed = ApprovalDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_ERROR',
        `请求体不合法（本端点只接受 token/decision/reason 三个键）：${parsed.error.issues.map((i) => i.message).join('；')}`,
        400,
      );
    }
    const result = this.approvals.submitDecision(
      params.data.id,
      parsed.data.token,
      parsed.data.decision,
      parsed.data.reason ?? null,
    );
    res.json({ ok: true, ...result });
  }

  revise(req: Request, res: Response): void {
    const params = ApprovalIdParamSchema.safeParse(req.params);
    if (!params.success) throw new AppError('VALIDATION_ERROR', 'approvalId 不合法', 400);
    const parsed = ApprovalReviseSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_ERROR',
        `请求体不合法（本端点只接受 token/arguments 两个键）：${parsed.error.issues.map((i) => i.message).join('；')}`,
        400,
      );
    }
    const result = this.approvals.revise(params.data.id, parsed.data.token, parsed.data.arguments);
    res.json({ ok: true, ...result });
  }

  reissue(req: Request, res: Response): void {
    const params = ApprovalIdParamSchema.safeParse(req.params);
    if (!params.success) throw new AppError('VALIDATION_ERROR', 'approvalId 不合法', 400);
    const parsed = ApprovalReissueSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_ERROR',
        `请求体不合法（本端点只接受 token 一个键）：${parsed.error.issues.map((i) => i.message).join('；')}`,
        400,
      );
    }
    const result = this.approvals.prolong(params.data.id, parsed.data.token);
    res.json({ ok: true, ...result });
  }
}
