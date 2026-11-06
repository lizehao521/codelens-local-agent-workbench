/** Tools routes: registry listing and enable/disable overrides. */

import { Router } from 'express';
import type { ToolsController } from '../controllers/tools.controller.js';

export function createToolsRoutes(controller: ToolsController): Router {
  const router = Router();
  router.get('/tools', (req, res) => controller.list(req, res));
  router.patch('/tools/:name', (req, res) => controller.patch(req, res));
  return router;
}
