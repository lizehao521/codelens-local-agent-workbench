/** Judge routes：判据塔只读视图（判决历史 / 自证状态 / 经验有效性 / 判决复算）。 */

import { Router } from 'express';
import type { JudgeController } from '../controllers/judge.controller.js';

export function createJudgeRoutes(controller: JudgeController): Router {
  const router = Router();
  router.get('/judge/runs', (req, res) => controller.listRuns(req, res));
  // replay 必须排在 /judge/runs/:id 之前也安全（Express 按注册顺序匹配），
  // 但显式写在前面可避免后来者改成通配路由时把它吃掉。
  router.get('/judge/runs/:id/replay', (req, res) => controller.replay(req, res));
  router.get('/judge/runs/:id', (req, res) => controller.getRun(req, res));
  // 深判是唯一的写端点：追加一行子判决，绝不改动原行。
  router.post('/judge/runs/:id/deep-judge', (req, res, next) => {
    void controller.deepJudge(req, res).catch(next);
  });
  router.get('/judge/selfcheck', (req, res) => controller.selfCheck(req, res));
  router.get('/judge/effectiveness', (req, res) => controller.effectiveness(req, res));
  // 洞察视图：只读聚合（四层状态 / 两档分布 / 深判花费 / 经验注入）。
  router.get('/judge/insight', (req, res) => controller.insight(req, res));
  return router;
}
