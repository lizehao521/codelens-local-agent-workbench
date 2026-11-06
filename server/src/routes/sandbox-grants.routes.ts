/**
 * Sandbox grants routes — 工作区外按目录授权的决定面。
 *
 *  - GET    /sandbox-grants              → 长期授权列表
 *  - POST   /sandbox-grants/:id/decision → 允许 / 拒绝一个待决请求
 *  - DELETE /sandbox-grants/:id          → 撤销（软删除，保留审计行）
 *
 * 强化「边界可控」维度：越界访问不再只能硬拒绝，也不需要整表白名单。
 */

import { Router } from 'express';
import type { SandboxGrantsController } from '../controllers/sandbox-grants.controller.js';

export function createSandboxGrantsRoutes(deps: { grants: SandboxGrantsController }): Router {
  const router = Router();
  router.get('/sandbox-grants', (req, res) => deps.grants.list(req, res));
  router.post('/sandbox-grants/:id/decision', (req, res) => deps.grants.decide(req, res));
  router.delete('/sandbox-grants/:id', (req, res) => deps.grants.revoke(req, res));
  return router;
}
