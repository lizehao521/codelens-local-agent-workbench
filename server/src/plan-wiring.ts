// 集中装配 plan 依赖，供 app.ts 调用以避开 runtime.ts 行数上限
import type { Db } from './repositories/db.js';
import { SessionRepository } from './services/memory/session.repository.js';
import { PlanRepository } from './repositories/plan.repository.js';
import { PlanService } from './services/plan/plan.service.js';
import { PlanController } from './controllers/plan.controller.js';

export function createPlanController(db: Db): PlanController {
  const sessionRepo = new SessionRepository(db);
  const planRepo = new PlanRepository(db);
  const planService = new PlanService(planRepo);
  return new PlanController(sessionRepo, planService);
}
