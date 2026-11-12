/**
 * RSI 自我迭代路由。
 *
 * 读端点三个（契约 / 迭代列表 / 单条），动作端点两个（域申请 / 记录决定）。
 * 动作端点都不改代码——判定与执行分离，见 RsiController 文件头。
 */

import { Router } from 'express';
import type { RsiController } from '../controllers/rsi.controller.js';

export function createRsiRoutes(controller: RsiController): Router {
  const router = Router();
  router.get('/rsi/contract', (req, res) => controller.contract(req, res));
  router.get('/rsi/iterations', (req, res) => controller.iterations(req, res));
  // plan 必须排在 /rsi/iterations/:id 之前：否则 "plan" 会被当成一个 id。
  router.post('/rsi/iterations/plan', (req, res) => controller.plan(req, res));
  router.get('/rsi/decisions', (req, res) => controller.decisions(req, res));
  router.get('/rsi/iterations/:id', (req, res) => controller.iteration(req, res));
  router.post('/rsi/iterations/:id/decide', (req, res) => controller.decide(req, res));
  return router;
}
