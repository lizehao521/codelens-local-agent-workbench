/**
 * API router: aggregates the v1 surface (spec 5 — 23 endpoints).
 * health lives at /api/health (no /v1), everything else under /api/v1.
 */

import { Router } from 'express';
import { createAgentRoutes } from './agent.routes.js';
import { createSessionsRoutes } from './sessions.routes.js';
import { createToolsRoutes } from './tools.routes.js';
import { createMcpRoutes } from './mcp.routes.js';
import { createProvidersRoutes } from './providers.routes.js';
import { createSandboxPermissionsRoutes } from './sandbox-permissions.routes.js';
import { createJudgeRoutes } from './judge.routes.js';
import { createCapabilitiesRoutes } from './capabilities.routes.js';
import { createTracesRoutes } from './traces.routes.js';
import { createSkillsRoutes } from './skills.routes.js';
import { createCheckpointsRoutes } from './checkpoints.routes.js';
import { createSandboxGrantsRoutes } from './sandbox-grants.routes.js';
import { createRunsRoutes } from './runs.routes.js';
import type { AgentController } from '../controllers/agent.controller.js';
import type { ApprovalController } from '../controllers/approval.controller.js';
import type { SessionsController } from '../controllers/sessions.controller.js';
import type { ToolsController } from '../controllers/tools.controller.js';
import type { McpController } from '../controllers/mcp.controller.js';
import type { ProvidersController } from '../controllers/providers.controller.js';
import type { HealthController } from '../controllers/health.controller.js';
import type { SandboxPermissionsController } from '../controllers/sandbox-permissions.controller.js';
import type { JudgeController } from '../controllers/judge.controller.js';
import type { CapabilitiesController } from '../controllers/capabilities.controller.js';
import type { TracesController } from '../controllers/traces.controller.js';
import type { SkillsController } from '../controllers/skills.controller.js';
import type { CheckpointsController } from '../controllers/checkpoints.controller.js';
import type { SandboxGrantsController } from '../controllers/sandbox-grants.controller.js';
import type { RunsController } from '../controllers/runs.controller.js';

export interface ApiRouterDeps {
  agent: AgentController;
  approvals: ApprovalController;
  sessions: SessionsController;
  tools: ToolsController;
  mcp: McpController;
  providers: ProvidersController;
  health: HealthController;
  sandboxPermissions: SandboxPermissionsController;
  judge: JudgeController;
  capabilities: CapabilitiesController;
  traces: TracesController;
  skills: SkillsController;
  checkpoints: CheckpointsController;
  sandboxGrants: SandboxGrantsController;
  runs: RunsController;
}

export function createApiRouter(deps: ApiRouterDeps): Router {
  const router = Router();

  // health (no /v1)
  router.get('/health', (req, res) => deps.health.check(req, res));

  // /api/v1/*
  const v1 = Router();
  v1.use(createAgentRoutes(deps.agent, deps.approvals));
  v1.use(createSessionsRoutes(deps.sessions));
  v1.use(createToolsRoutes(deps.tools));
  v1.use(createMcpRoutes(deps.mcp));
  v1.use(createProvidersRoutes(deps.providers));
  // 注意要带前缀：路由文件里是 router.get('/') / router.put('/')，
  // 直接 v1.use(router) 会把它挂到 /api/v1/ 根上，
  // 于是文档里的 PUT /api/v1/sandbox-permissions 返回 404。
  v1.use('/sandbox-permissions', createSandboxPermissionsRoutes(deps.sandboxPermissions));
  v1.use(createJudgeRoutes(deps.judge));
  v1.use(createCapabilitiesRoutes({ capabilities: deps.capabilities }));
  v1.use(createTracesRoutes({ traces: deps.traces }));
  v1.use(createSkillsRoutes({ skills: deps.skills }));
  v1.use(createCheckpointsRoutes({ checkpoints: deps.checkpoints }));
  v1.use(createSandboxGrantsRoutes({ grants: deps.sandboxGrants }));
  v1.use(createRunsRoutes({ runs: deps.runs }));
  router.use('/v1', v1);

  return router;
}
