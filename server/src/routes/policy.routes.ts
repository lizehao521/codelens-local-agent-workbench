/**
 * Policy routes —— π 版本面。
 *
 * 两个端点，写操作只有一个（回滚），原因见 PolicyController 文件头：
 * 经验的产生必须由 Judge 判决驱动，HTTP 面不允许直接改 π。
 */

import { Router } from 'express';
import type { PolicyController } from '../controllers/policy.controller.js';

export function createPolicyRoutes(controller: PolicyController): Router {
  const router = Router();
  router.get('/policy/versions', (req, res) => controller.listVersions(req, res));
  router.post('/policy/rollback', (req, res) => controller.rollback(req, res));
  return router;
}