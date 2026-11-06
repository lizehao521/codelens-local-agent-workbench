/**
 * SseWriter — typed event → frame bridge for the agent loop. Thin over utils/sse.ts;
 * exists so services never touch Express Response directly (dependency rule).
 */

import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { sendSSEEvent, setSSEHeaders, startSSEHeartbeat, endSSE } from '../../utils/sse.js';
import type { AgentEvent, AgentEventMap, AgentEventName, AgentRunStage } from '../../types/agent-events.js';

export class SseWriter {
  private readonly stopHeartbeat: () => void;
  private closed = false;
  /** R3：run 级阶段计时。writer 与单次请求一一对应，天然是 run 的作用域。 */
  private stageRunId = '';
  private stageStartedAt = 0;
  private readonly emittedStages = new Set<AgentRunStage>();

  constructor(private readonly res: Response) {
    setSSEHeaders(res);
    this.stopHeartbeat = startSSEHeartbeat(res);
  }

  /** 请求被接受时调用一次（在访问上游之前），返回本次 run 的标识。 */
  beginRunStage(runId: string = randomUUID()): string {
    if (this.stageStartedAt === 0) {
      this.stageRunId = runId;
      this.stageStartedAt = Date.now();
    }
    return this.stageRunId;
  }

  /** 当前 run 标识（未开始时为空串）。 */
  get runId(): string {
    return this.stageRunId;
  }

  /**
   * 发一个阶段事件。同一阶段只发一次——connecting 由 controller 与 loop 双保险时不会重复，
   * 多轮迭代中的 reasoning / content 也不会把流刷成噪声。
   */
  emitStage(stage: AgentRunStage, detail: string | null = null): void {
    if (this.closed || this.res.writableEnded || this.res.destroyed) return;
    if (this.stageStartedAt === 0) this.beginRunStage();
    if (this.emittedStages.has(stage)) return;
    this.emittedStages.add(stage);
    const now = Date.now();
    this.emit('stage', {
      runId: this.stageRunId,
      stage,
      at: now,
      elapsedMs: now - this.stageStartedAt,
      detail,
    });
  }

  emit<K extends AgentEventName>(event: K, payload: AgentEventMap[K]): void {
    if (this.closed || this.res.writableEnded || this.res.destroyed) return;
    sendSSEEvent(this.res, event, payload);
  }

  emitEvent(agentEvent: AgentEvent): void {
    this.emit(agentEvent.type, agentEvent.payload as never);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    endSSE(this.res);
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
