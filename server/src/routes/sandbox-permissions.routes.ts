/** Sandbox permission routes: GET / PUT /api/v1/sandbox-permissions. */

import { Router } from 'express';
import type { SandboxPermissionsController } from '../controllers/sandbox-permissions.controller.js';

export function createSandboxPermissionsRoutes(controller: SandboxPermissionsController): Router {
  const router = Router();
  router.get('/', (req, res) => controller.get(req, res));
  router.put('/', (req, res) => controller.put(req, res));
  return router;
}
