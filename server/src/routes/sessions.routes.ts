/** Session routes: CRUD + recovery codes + cross-browser recovery. */

import { Router } from 'express';
import type { SessionsController } from '../controllers/sessions.controller.js';

export function createSessionsRoutes(controller: SessionsController): Router {
  const router = Router();
  router.get('/sessions', (req, res) => controller.list(req, res));
  router.post('/sessions', (req, res) => controller.create(req, res));
  router.post('/sessions/recover', (req, res) => controller.recover(req, res));
  router.post('/sessions/:id/recovery-code', (req, res) => controller.regenerateRecoveryCode(req, res));
  router.get('/sessions/:id', (req, res) => controller.detail(req, res));
  router.get('/sessions/:id/usage', (req, res) => controller.usage(req, res));
  router.patch('/sessions/:id', (req, res) => controller.patch(req, res));
  router.delete('/sessions/:id', (req, res) => controller.remove(req, res));
  return router;
}
