/**
 * Agent controller: POST /api/v1/agent/stream (SSE) and POST /api/v1/agent/abort.
 * Error split (spec 3.3.11): failures BEFORE the SSE headers go out are HTTP
 * 4xx JSON; everything after (missing key, upstream errors) is an SSE `error`
 * event with HTTP status 200.
 */

import type { Request, Response } from 'express';
import { AppError } from '../utils/errors.js';
import { SseWriter } from '../services/agent/sse-writer.js';
import type { AgentLoopService, AgentRunRequest } from '../services/agent/agent-loop.service.js';
import type { AbortRegistry } from '../services/agent/abort-registry.js';
import { FallbackBudgetService } from '../services/agent/fallback-budget.service.js';
import type { TrialUpstreamHealth } from '../services/agent/trial-health.service.js';
import { AgentRequestSchema } from '../validators/agent.schema.js';

/** 试用锁定的上游信息（只含地址与模型，不含密钥）。 */
export interface TrialUpstreamStatus {
  provider: string;
  model: string;
  baseUrl: string | null;
  /** R4：真实生成探测的三态结果 + 探测时间/耗时/用量。 */
  health: TrialUpstreamHealth;
}

export class AgentController {
  constructor(
    private readonly loop: AgentLoopService,
    private readonly abortRegistry: AbortRegistry,
    private readonly fallbackBudget: FallbackBudgetService,
    /** 试用锁定上游的描述器；未启用试用锁定时返回 null。 */
    private readonly trialUpstream?: () => TrialUpstreamStatus | null,
  ) {}

  async stream(req: Request, res: Response): Promise<void> {
    const parsed = AgentRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_ERROR',
        `请求参数不合法：${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`,
        400,
      );
    }
    const body = parsed.data;

    // Pre-header validation: an existing sessionId must resolve (else 404 JSON).
    if (body.sessionId && !this.loop.sessionExists(body.sessionId)) {
      throw new AppError('SESSION_NOT_FOUND', '会话不存在或已被删除', 404);
    }

    // This request owns the abort signal; the loop mirrors it into the registry
    // under the real session id so POST /agent/abort can reach a running task.
    const requestController = new AbortController();
    const onClose = (): void => requestController.abort();
    res.on('close', onClose);

    const writer = new SseWriter(res);
    try {
      // R3：请求已被接受、尚未访问任何上游（含能力探测）——先回执 connecting + runId，
      // 让客户端立刻进入「正在连接模型…」态，而不是等首个内容块才动。
      writer.beginRunStage();
      writer.emitStage('connecting');
      // 注入客户端来源 IP：兜底 Key 试用/预算闸按 IP 记账（trust proxy 已由 app 配置）。
      await this.loop.run({ ...body, clientIp: req.ip } as AgentRunRequest, writer, requestController.signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writer.emit('error', {
        code: 'INTERNAL_ERROR',
        message: `Agent 内部错误：${message.slice(0, 300)}`,
        retryable: false,
      });
    } finally {
      res.off('close', onClose);
      writer.close();
    }
  }

  abort(req: Request, res: Response): void {
    const sessionId = String(req.body?.sessionId ?? '');
    if (!sessionId) {
      throw new AppError('VALIDATION_ERROR', 'sessionId 不能为空', 400);
    }
    const aborted = this.abortRegistry.abort(sessionId);
    res.json({ ok: true, aborted });
  }

  /** GET /agent/trial-status：兜底 Key 试用/预算状态（按请求 IP），供前端转化横幅。 */
  trialStatus(req: Request, res: Response): void {
    res.json({
      ...this.fallbackBudget.describe(req.ip ?? 'unknown'),
      // 前端据此置灰上游选择器并展示「试用固定上游」；失败时给出可诊断信息。
      trialUpstream: this.trialUpstream?.() ?? null,
    });
  }
}
