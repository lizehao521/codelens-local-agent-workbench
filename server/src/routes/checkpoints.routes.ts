/**
 * Checkpoints routes — 工作区快照 / 回滚。
 *
 * 挂在 /api/v1 下：
 *  - GET  /checkpoints?sessionId=
 *  - POST /checkpoints/:id/rollback
 *
 * 回滚是唯一的写端点：路由层不做任何「自动确认」的兜底，
 * 确认头必须由客户端显式带上（见 controller 的双重闸门说明）。
 */

import { Router } from 'express';
import type { CheckpointsController } from '../controllers/checkpoints.controller.js';

export function createCheckpointsRoutes(deps: { checkpoints: CheckpointsController }): Router {
  const router = Router();
  router.get('/checkpoints', (req, res) => deps.checkpoints.list(req, res));
  // 回滚是异步的（文件 IO 走 node:fs/promises），必须把 rejection 交给
  // express 的错误中间件，否则异步抛出的错会变成「请求挂死」而不是 500。
  router.post('/checkpoints/:id/rollback', (req, res, next) => {
    void deps.checkpoints.rollback(req, res).catch(next);
  });
  // run 级证据链：查询 / 撤销 / 永久保留。
  router.get('/checkpoints/runs/:runId', (req, res) => deps.checkpoints.getRun(req, res));
  router.post('/checkpoints/runs/:runId/rollback', (req, res, next) => {
    void deps.checkpoints.rollbackRun(req, res).catch(next);
  });
  router.post('/checkpoints/:id/pin', (req, res) => deps.checkpoints.pin(req, res));
  return router;
}
