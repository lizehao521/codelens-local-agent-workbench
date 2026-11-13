/**
 * Sandbox grants controller — 工作区外「按目录授权」的用户决定入口。
 *
 *  - GET    /sandbox-grants              → 当前长期授权列表
 *  - POST   /sandbox-grants/:id/decision → { allow: boolean } 结算一个待决请求
 *  - DELETE /sandbox-grants/:id          → 撤销（写 revoked_at，不删历史）
 *
 * 授权弹卡由 run 的 SSE（sandbox_grant_required）送达；本端点只负责把
 * 用户的决定交回正在等待的调用。不存在的 id 返回 404 —— 待决请求可能已超时，
 * 这与「授权失败」是两回事，前端据此提示「已失效，请重新发起」。
 */

import type { Request, Response } from 'express';
import type { SandboxGrantService } from '../services/tools/sandbox-grant.service.js';

export class SandboxGrantsController {
  constructor(private readonly service: SandboxGrantService) {}

  list(_req: Request, res: Response): void {
    res.json({ grants: this.service.list() });
  }

  decide(req: Request, res: Response): void {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const body = (req.body ?? {}) as { allow?: unknown };
    if (typeof body.allow !== 'boolean') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'body.allow 必须是 boolean' } });
      return;
    }
    const result = this.service.decide(id, body.allow);
    if (!result.ok) {
      res.status(404).json({ error: { code: 'GRANT_NOT_FOUND', message: `授权请求不存在或已失效: ${id}` } });
      return;
    }
    res.json({ ok: true, decision: result.decision });
  }

  revoke(req: Request, res: Response): void {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    if (!this.service.revoke(id)) {
      res.status(404).json({ error: { code: 'GRANT_NOT_FOUND', message: `授权不存在或已撤销: ${id}` } });
      return;
    }
    res.json({ ok: true });
  }
}
