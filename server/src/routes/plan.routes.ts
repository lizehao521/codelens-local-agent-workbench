// 计划（Plan）相关路由：挂载在 /api/v1 下，全部同步转发给 PlanController
import { Router } from 'express';
import type { PlanController } from '../controllers/plan.controller.js';

export function createPlanRoutes(deps: { plans: PlanController }): Router {
  const router = Router();

  // 列出某会话下的所有计划
  router.get('/sessions/:sessionId/plans', (req, res) => deps.plans.list(req, res));
  // 获取单个计划详情
  router.get('/plans/:planId', (req, res) => deps.plans.detail(req, res));
  // 在某会话下新建计划
  router.post('/sessions/:sessionId/plans', (req, res) => deps.plans.create(req, res));
  // 整体替换某个计划
  router.put('/plans/:planId', (req, res) => deps.plans.replace(req, res));
  // 更新某个计划的状态
  router.patch('/plans/:planId/status', (req, res) => deps.plans.status(req, res));

  return router;
}
