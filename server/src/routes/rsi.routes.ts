/**
 * RSI 自我迭代路由。
 *
 * 读端点五个（契约 / 规则契约 / 看板读数 / 迭代列表 / 单条），动作端点两个（域申请 / 记录决定）。
 * 动作端点都不改代码——判定与执行分离，见 RsiController 文件头。
 *
 * `/rsi/rules` 与 `/rsi/overview` 是旧路径 `/api/rsi/*` 的正式归属地：
 * 两个出口共用同一个 controller 方法，所以响应体在结构上不可能分叉，
 * 旧路径只保留一行转发（见 app.ts），等前端与外部脚本全部迁完即可摘除。
 */

import { Router } from 'express';
import type { RsiController } from '../controllers/rsi.controller.js';

export function createRsiRoutes(controller: RsiController): Router {
  const router = Router();
  router.get('/rsi/contract', (req, res) => controller.contract(req, res));
  // 契约的第二个出口：与 /rsi/contract 同源，但显式 no-store（供看板/一致性脚本消费）。
  router.get('/rsi/rules', (_req, res) => controller.rules(_req, res));
  // 看板读数：查询参数 session 必填，缺参 400、会话不存在 404，与原实现一致。
  router.get('/rsi/overview', (req, res) => controller.overview(req, res));
  router.get('/rsi/iterations', (req, res) => controller.iterations(req, res));
  // plan 必须排在 /rsi/iterations/:id 之前：否则 "plan" 会被当成一个 id。
  router.post('/rsi/iterations/plan', (req, res) => controller.plan(req, res));
  router.get('/rsi/decisions', (req, res) => controller.decisions(req, res));
  router.get('/rsi/iterations/:id', (req, res) => controller.iteration(req, res));
  router.post('/rsi/iterations/:id/decide', (req, res) => controller.decide(req, res));
  return router;
}
