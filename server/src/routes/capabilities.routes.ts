/** Capabilities routes：GET /api/v1/capabilities（只读能力开关目录）。 */

import { Router } from 'express';
import type { CapabilitiesController } from '../controllers/capabilities.controller.js';

export interface CapabilitiesRoutesDeps {
  capabilities: CapabilitiesController;
}

export function createCapabilitiesRoutes(deps: CapabilitiesRoutesDeps): Router {
  const router = Router();
  router.get('/capabilities', (req, res) => deps.capabilities.list(req, res));
  return router;
}
