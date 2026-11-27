/**
 * RSI Proposals/Reflection Routes —— Minis 侧写入/查询闭环的 HTTP 端点。
 *
 * 挂载点：/api/v1/rsi
 *   POST   /proposals           -> RsiProposalsController.storeProposal
 *   GET    /proposals/:id       -> RsiProposalsController.getProposal
 *   GET    /reflection          -> RsiReflectionController.getReflection
 *   GET    /failed-runs         -> RsiReflectionController.getFailedRuns
 */

import { Router } from 'express';
import type { RsiProposalsController } from '../controllers/rsi-proposals.controller.js';
import type { RsiReflectionController } from '../controllers/rsi-reflection.controller.js';

export function createRsiProposalsRoutes(
  deps: { proposals: RsiProposalsController; reflection: RsiReflectionController }
): Router {
  const router = Router();

  // POST /api/v1/rsi/proposals - 存储提案制品（Minis 推送）
  router.post('/proposals', (req, res) => deps.proposals.storeProposal(req, res));

  // GET /api/v1/rsi/proposals/:id - 读取提案制品
  router.get('/proposals/:id', (req, res) => deps.proposals.getProposal(req, res));

  // GET /api/v1/rsi/reflection - 最近 N 条 RSI 反思报告
  router.get('/reflection', (req, res) => deps.reflection.getReflection(req, res));

  // GET /api/v1/rsi/failed-runs - 最近 N 条失败 run 摘要
  router.get('/failed-runs', (req, res) => deps.reflection.getFailedRuns(req, res));

  return router;
}