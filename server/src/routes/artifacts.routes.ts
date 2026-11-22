/**
 * Artifacts routes — P1-6 artifacts 面板（只读）。
 *
 * 挂在 /api/v1 之下：
 *  - GET /sessions/:sessionId/artifacts        → artifact 元数据列表
 *  - GET /sessions/:sessionId/artifacts/:id    → 单条 artifact 正文
 *
 * detail 是异步的（读盘走 node:fs/promises），rejection 必须交给 express 错误中间件。
 */

import { Router } from 'express';
import type { ArtifactsController } from '../controllers/artifacts.controller.js';

export function createArtifactsRoutes(deps: { artifacts: ArtifactsController }): Router {
  const router = Router();
  router.get('/sessions/:sessionId/artifacts', (req, res) => deps.artifacts.list(req, res));
  router.get('/sessions/:sessionId/artifacts/:id', (req, res, next) => {
    void deps.artifacts.detail(req, res).catch(next);
  });
  return router;
}
