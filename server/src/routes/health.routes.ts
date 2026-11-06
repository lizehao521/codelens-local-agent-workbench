/** Health route: /health (no /api prefix, spec 5). */

import { Router } from 'express';
import type { HealthController } from '../controllers/health.controller.js';

export function createHealthRoutes(controller: HealthController): Router {
  const router = Router();
  router.get('/health', (req, res) => controller.check(req, res));
  return router;
}
