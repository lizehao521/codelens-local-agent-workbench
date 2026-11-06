/**
 * Traces controller — 运行轨迹的只读视图。
 *
 * 一个端点两种形态（靠 query 参数区分）：
 *  - GET /api/v1/traces?limit=50    → 轨迹列表（新的在前）
 *  - GET /api/v1/traces?traceId=xxx → 单条轨迹的 span 明细（按发生顺序）
 *
 * 只读：轨迹由运行时产生，不接受客户端写入 —— 否则「轨迹来自真实运行」这条
 * 前提就会被 HTTP 请求绕过。
 *
 * 越界处理（limit 的收敛）全在 service 里，这里只做类型转换，不做判断。
 */

import type { Request, Response } from 'express';
import type { TraceService } from '../services/observability/trace.service.js';

export class TracesController {
  constructor(private readonly service: TraceService) {}

  list(req: Request, res: Response): void {
    const enabled = this.service.enabled;

    // 单条明细：traceId 非空即走明细分支。数组形态（?traceId=a&traceId=b）
    // 视为未指定 —— 没有哪条轨迹能同时是两条。
    const rawTraceId = typeof req.query.traceId === 'string' ? req.query.traceId.trim() : '';
    if (rawTraceId) {
      res.json({ enabled, traceId: rawTraceId, spans: this.service.getSpans(rawTraceId) });
      return;
    }

    // 只做 string → number 的类型转换；非法值 / 越界的收敛由 service 统一处理。
    const rawLimit = typeof req.query.limit === 'string' ? req.query.limit : undefined;
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    res.json({ enabled, traces: this.service.list(limit) });
  }
}
