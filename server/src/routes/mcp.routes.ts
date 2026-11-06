/** MCP connector routes (P1): CRUD + connect/disconnect. */

import { Router } from 'express';
import type { McpController } from '../controllers/mcp.controller.js';

export function createMcpRoutes(controller: McpController): Router {
  const router = Router();
  router.get('/mcp/servers', (req, res) => controller.list(req, res));
  router.post('/mcp/servers', (req, res) => controller.create(req, res));
  router.patch('/mcp/servers/:id', (req, res) => controller.patch(req, res));
  router.delete('/mcp/servers/:id', (req, res, next) => void controller.remove(req, res).catch(next));
  router.post('/mcp/servers/:id/connect', (req, res, next) => void controller.connect(req, res).catch(next));
  router.post('/mcp/servers/:id/disconnect', (req, res, next) => void controller.disconnect(req, res).catch(next));
  return router;
}
