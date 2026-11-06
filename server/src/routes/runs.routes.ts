/**
 * Runs routes — RunState 的结构化查询面（按 runId / 按 session）。
 *
 *  - GET /runs?sessionId=&limit= → 最近 N 个 run（含汇报摘要）
 *  - GET /runs/:runId             → 单个 run 的完整状态 + 汇报卡
 *
 * 强化「自我状态感知」维度：Agent 的每一步、审批、文件改动与成本都能被
 * 事后按 run 查到，而不是只活在 SSE 流里。
 */

import { Router } from 'express';
import type { RunsController } from '../controllers/runs.controller.js';

export function createRunsRoutes(deps: { runs: RunsController }): Router {
  const router = Router();
  router.get('/runs', (req, res) => deps.runs.list(req, res));
  router.get('/runs/:runId/audit', (req, res) => deps.runs.audit(req, res));
  // resume 是 async：必须把 rejection 交给 next，否则服务层异常会让请求悬挂
  // （客户端收不到 5xx，只能等超时）。
  router.post('/runs/:runId/resume', (req, res, next) => {
    void deps.runs.resume(req, res).catch(next);
  });
  router.get('/runs/:runId', (req, res) => deps.runs.get(req, res));
  return router;
}
