/**
 * Plugins routes：UI 插件管理（列表 / 安装 / 卸载 / 启用/禁用）。
 *
 * 挂在 /api/v1 之下：
 *  - GET    /plugins              列表（内置 + 自定义）
 *  - POST   /plugins              创建/安装插件
 *  - DELETE /plugins/:id          卸载插件
 *  - PATCH  /plugins/:id/toggle   启用/禁用插件
 */

import { Router } from 'express';
import type { PluginsController } from '../controllers/plugins.controller.js';

export function createPluginsRoutes(deps: { plugins: PluginsController }): Router {
  const router = Router();
  router.get('/', (req, res) => deps.plugins.list(req, res));
  router.post('/', (req, res) => deps.plugins.create(req, res));
  router.post('/import', (req, res) => deps.plugins.importJson(req, res));
  router.delete('/:id', (req, res) => deps.plugins.remove(req, res));
  router.patch('/:id/toggle', (req, res) => deps.plugins.toggle(req, res));
  return router;
}