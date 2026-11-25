/**
 * RSI Scheduler 手工触发路由。
 *
 * 工厂模式接收 getScheduler getter（闭包取单例），不直接 import db，
 * 避免在 ApiRouterDeps 里为 scheduler 引入新字段。
 */

import { Router, type Request, type Response } from 'express';
import type { RsiSchedulerService } from '../services/rsi/scheduler.service.js';

export function createRsiSchedulerRoutes(
  getScheduler: () => RsiSchedulerService | null
): Router {
  const router = Router();

  // POST /v1/rsi/scheduler/trigger —— 手工触发一次 self-upgrade-loop
  router.post('/rsi/scheduler/trigger', async (req: Request, res: Response) => {
    const scheduler = getScheduler();
    if (!scheduler) {
      res.status(503).json({ error: 'Scheduler not initialized' });
      return;
    }
    const reason = (req.body?.reason as string) || 'manual-trigger';
    try {
      const result = await scheduler.trigger(reason);
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /v1/rsi/scheduler/trigger-async —— 异步触发（立即返回，循环后台跑）
  // 专供 rsi.exec 60s 硬超时窗口内的自动化循环：只返回受理回执，
  // 真正的 self-upgrade-loop 在后台执行，结果通过 status 的 lastRun 与 scheduler_runs 观测。
  router.post('/rsi/scheduler/trigger-async', (req: Request, res: Response) => {
    const scheduler = getScheduler();
    if (!scheduler) {
      res.status(503).json({ error: 'Scheduler not initialized' });
      return;
    }
    const reason = (req.body?.reason as string) || 'manual-async';
    const result = scheduler.triggerAsync(reason);
    // 202 Accepted = 已受理、后台在跑；200 + accepted=false = 上一轮仍在跑，本轮未启动。
    res.status(result.accepted ? 202 : 200).json({ ok: true, ...result });
  });

  // GET /v1/rsi/scheduler/status —— 观测面
  router.get('/rsi/scheduler/status', async (_req: Request, res: Response) => {
    const scheduler = getScheduler();
    if (!scheduler) {
      res.status(503).json({ error: 'Scheduler not initialized' });
      return;
    }
    try {
      // 异步版拿 nextCron；同步版 nextCron 恒为 null
      res.json(await scheduler.getStatusAsync());
    } catch {
      res.json(scheduler.getStatus());
    }
  });

  return router;
}
