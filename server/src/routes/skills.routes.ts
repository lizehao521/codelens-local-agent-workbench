/**
 * Skills routes：程序化技能库（列表 / 匹配 / 创建 / 删除）。
 *
 * 挂在 /api/v1 之下：
 *  - GET    /skills?q=&limit=&topK=   有 q → 匹配模式；无 q → 列表模式
 *  - POST   /skills                   创建技能
 *  - DELETE /skills/:name             删除技能
 *
 * 路由只做转发：参数解析与错误映射都在 controller / service 里，
 * 路由层不引入任何业务判断。
 */

import { Router } from 'express';
import type { SkillsController } from '../controllers/skills.controller.js';

export function createSkillsRoutes(deps: { skills: SkillsController }): Router {
  const router = Router();
  router.get('/skills', (req, res) => deps.skills.list(req, res));
  router.post('/skills', (req, res) => deps.skills.create(req, res));
  router.delete('/skills/:name', (req, res) => deps.skills.remove(req, res));
  return router;
}
