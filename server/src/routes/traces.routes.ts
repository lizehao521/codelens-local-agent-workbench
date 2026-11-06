/** Traces routes：运行轨迹只读视图（列表 / 单条 span 明细）。挂在 /api/v1 下。 */

import { Router } from 'express';
import type { TracesController } from '../controllers/traces.controller.js';

export function createTracesRoutes(deps: { traces: TracesController }): Router {
  const router = Router();
  router.get('/traces', (req, res) => deps.traces.list(req, res));
  return router;
}
