/** Providers routes: catalogue (with merged capabilities) and probe results. */

import { Router } from 'express';
import type { ProvidersController } from '../controllers/providers.controller.js';

export function createProvidersRoutes(controller: ProvidersController): Router {
  const router = Router();
  router.get('/providers', (req, res) => controller.list(req, res));
  router.get('/providers/capabilities', (req, res) => controller.capabilitiesList(req, res));
  router.get('/providers/sync-status', (req, res) => controller.syncStatus(req, res));
  return router;
}
