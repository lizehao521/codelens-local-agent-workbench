/** Agent routes: SSE stream, abort, and the two approval endpoints. */

import { Router } from 'express';
import type { AgentController } from '../controllers/agent.controller.js';
import type { ApprovalController } from '../controllers/approval.controller.js';

export function createAgentRoutes(agent: AgentController, approvals: ApprovalController): Router {
  const router = Router();
  router.post('/agent/stream', (req, res, next) => void agent.stream(req, res).catch(next));
  router.post('/agent/abort', (req, res) => agent.abort(req, res));
  router.get('/agent/trial-status', (req, res) => agent.trialStatus(req, res));
  router.post('/approvals/:id', (req, res) => approvals.decide(req, res));
  router.post('/approvals/:id/revise', (req, res) => approvals.revise(req, res));
  router.post('/approvals/:id/reissue', (req, res) => approvals.reissue(req, res));
  return router;
}
