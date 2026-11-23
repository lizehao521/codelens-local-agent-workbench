// PlanController：会话维度的计划（Plan）HTTP 接口层。
// 职责：参数校验（zod）、会话归属校验（X-Device-Token 哈希比对）、
// 错误映射（AppError）与响应组装，业务逻辑全部委托给 PlanService。
import { z } from 'zod';
import type { Request, Response } from 'express';

import { AppError } from '../utils/errors.js';
import { sha256Hex } from '../utils/hash.js';
import type { SessionRepository, SessionRow } from '../services/memory/session.repository.js';
import { PlanService, PlanInvalidTransitionError } from '../services/plan/plan.service.js';
import type { PlanStatus } from '../repositories/plan.repository.js';
import {
  CreatePlanSchema,
  ReplacePlanSchema,
  PlanIdParamSchema,
  SessionIdParamSchema,
  PlanListQuerySchema,
} from '../validators/plan.schema.js';

// status 请求体没有现成 schema，在此定义。
const StatusBodySchema = z.object({
  status: z.enum(['draft', 'approved', 'running', 'done', 'cancelled']),
});

export class PlanController {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly plans: PlanService,
  ) {}

  /** 归属校验：会话未绑定设备 token 时放行；否则比对请求头哈希。 */
  private assertOwned(session: SessionRow, req: Request): void {
    if (!session.device_token_hash) return;
    const token = req.header('X-Device-Token');
    if (token && sha256Hex(token) === session.device_token_hash) return;
    throw new AppError('SESSION_ACCESS_DENIED', 'device token mismatch', 403);
  }

  /** 加载并校验会话归属，返回会话行。 */
  private loadSession(req: Request): SessionRow {
    const parsed = SessionIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'invalid sessionId param', 400);
    }
    const session = this.sessions.get(parsed.data.sessionId);
    if (!session) {
      throw new AppError('SESSION_NOT_FOUND', 'session not found', 404);
    }
    this.assertOwned(session, req);
    return session;
  }

  /** 加载计划并校验其所属会话的归属，返回计划视图。 */
  private loadPlan(req: Request) {
    const parsed = PlanIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'invalid planId param', 400);
    }
    const plan = this.plans.get(parsed.data.planId);
    if (!plan) {
      throw new AppError('PLAN_NOT_FOUND', 'plan not found', 404);
    }
    const session = this.sessions.get(plan.sessionId);
    if (!session) {
      throw new AppError('SESSION_NOT_FOUND', 'session not found', 404);
    }
    this.assertOwned(session, req);
    return plan;
  }

  list(req: Request, res: Response): void {
    const session = this.loadSession(req);
    const query = PlanListQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new AppError('VALIDATION_ERROR', 'invalid query', 400);
    }
    res.json({
      sessionId: session.id,
      plans: this.plans.listBySession(session.id, query.data.limit),
    });
  }

  detail(req: Request, res: Response): void {
    res.json({ plan: this.loadPlan(req) });
  }

  create(req: Request, res: Response): void {
    const session = this.loadSession(req);
    const body = CreatePlanSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError('VALIDATION_ERROR', 'invalid create body', 400);
    }
    const plan = this.plans.create(session.id, body.data);
    res.status(201).json({ plan });
  }

  replace(req: Request, res: Response): void {
    this.loadPlan(req); // 归属校验
    const body = ReplacePlanSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError('VALIDATION_ERROR', 'invalid replace body', 400);
    }
    const plan = this.plans.replace(String(req.params.planId), body.data);
    if (!plan) {
      throw new AppError('PLAN_NOT_FOUND', 'plan not found', 404);
    }
    res.json({ plan });
  }

  status(req: Request, res: Response): void {
    this.loadPlan(req); // 归属校验
    const body = StatusBodySchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError('VALIDATION_ERROR', 'invalid status body', 400);
    }
    try {
      const plan = this.plans.transition(
        String(req.params.planId),
        body.data.status as PlanStatus,
      );
      if (!plan) {
        throw new AppError('PLAN_NOT_FOUND', 'plan not found', 404);
      }
      res.json({ plan });
    } catch (err) {
      if (err instanceof PlanInvalidTransitionError) {
        throw new AppError('PLAN_INVALID_TRANSITION', err.message, 409);
      }
      throw err;
    }
  }
}
