/**
 * Checkpoints controller — 工作区快照的只读视图与回滚入口。
 *
 * 两条端点：
 *  - GET  /checkpoints?sessionId=  → { enabled, checkpoints }
 *  - POST /checkpoints/:id/rollback → { enabled: true, report }
 *
 * 回滚是本能力**唯一的写操作**，因此走双重闸门（顺序固定）：
 *  1. 能力未启用              → 409 { enabled: false, error: { code: 'CAPABILITY_DISABLED', message } }
 *  2. 未带显式确认头           → 400 { error: '需要显式头 x-codelens-confirm: rollback 以确认回滚' }
 *  3. 两闸都过 → 执行回滚 → 200 { enabled: true, report: { ok, restored[], failed[] } }
 *
 * 为什么确认头是强制的：回滚会**覆盖工作区文件**。一次误点、一次脚本重放、
 * 一个被诱导的 Agent 调用，都可能把用户正在写的东西冲掉。要求调用方显式
 * 带上 `x-codelens-confirm: rollback`，等于要求「操作者本人确认过这次覆盖」。
 * 这是能力开关之外的第二道锁——开关管的是「有没有这个能力」，确认头管的是
 * 「这一次是不是真的要动手」。
 *
 * 本 controller 不吞错误：快照不存在等情形以 404 + `{ error }` 表达，
 * 与本端点另外两个闸门保持同一套 body 形状（扁平的 error 字符串）。
 *
 * ── 响应体里 `report` 的语义边界（前端展示要靠它）──────────────────────
 * `report.restored` 表示「这些文件的**内容**已还原到快照时的状态」，
 * **不是**「工作区已恢复成绝对状态」：快照之外的文件一律不动，包括
 * `fs.write rename a.txt -> b.txt` 的产物 `b.txt` —— 它拍快照时还不存在，
 * 因此回滚不会删除它（刻意语义：删除产物是第二次破坏的风险点）。
 * 详见 `CheckpointService` 的「契约边界」一节。
 */

import type { Request, Response } from 'express';
import {
  CheckpointNotFoundError,
  type CheckpointService,
} from '../services/tx/checkpoint.service.js';

/** 回滚确认头：值必须严格等于它，否则视为未确认。 */
export const ROLLBACK_CONFIRM_HEADER = 'x-codelens-confirm';
export const ROLLBACK_CONFIRM_VALUE = 'rollback';

export class CheckpointsController {
  constructor(private readonly service: CheckpointService) {}

  /**
   * GET /checkpoints?sessionId=
   *
   * 未启用时返回 `{ enabled: false, checkpoints: [] }`——前端据此隐藏入口，
   * 而不是收到一个 500 或一个「看起来有快照其实没有」的空数组。
   */
  list(req: Request, res: Response): void {
    const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId
      ? req.query.sessionId
      : undefined;
    const enabled = this.service.enabled;
    res.json({
      enabled,
      checkpoints: enabled ? this.service.list(sessionId) : [],
    });
  }

  /**
   * POST /checkpoints/:id/rollback
   *
   * 双重闸门见文件头。闸门顺序刻意固定为「先能力、后确认」：
   * 能力都没开时，用户填什么都没意义，先说清楚「这个能力不存在」。
   *
   * 闸门是同步判定（不碰 IO），但真正的回滚是异步的（文件 IO 走 node:fs/promises）。
   */
  async rollback(req: Request, res: Response): Promise<void> {
    // 闸门 1：能力未启用。
    if (!this.service.enabled) {
      res.status(409).json({ enabled: false, error: { code: 'CAPABILITY_DISABLED', message: 'CHECKPOINT_ENABLED 未开启' } });
      return;
    }

    // 闸门 2：缺显式确认头（值必须严格是 rollback）。
    const rawConfirm = req.headers[ROLLBACK_CONFIRM_HEADER];
    const confirm = Array.isArray(rawConfirm) ? rawConfirm[0] : rawConfirm;
    if (typeof confirm !== 'string' || confirm.trim() !== ROLLBACK_CONFIRM_VALUE) {
      res.status(400).json({
        error: {
          code: 'CONFIRM_HEADER_REQUIRED',
          message: `需要显式头 ${ROLLBACK_CONFIRM_HEADER}: ${ROLLBACK_CONFIRM_VALUE} 以确认回滚`,
        },
      });
      return;
    }

    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const body = (req.body ?? {}) as { files?: unknown };
    const files = Array.isArray(body.files)
      ? body.files.filter((f): f is string => typeof f === 'string')
      : undefined;
    try {
      const report = await this.service.restore(id, { files });
      res.json({ enabled: true, report });
    } catch (err) {
      if (err instanceof CheckpointNotFoundError) {
        res.status(404).json({ error: { code: 'CHECKPOINT_NOT_FOUND', message: err.message } });
        return;
      }
      throw err;
    }
  }

  /** GET /checkpoints/runs/:runId → 按 run 查「改了什么 + 来自哪一步」。 */
  getRun(req: Request, res: Response): void {
    if (!this.service.enabled) {
      res.status(409).json({ enabled: false, error: { code: 'CAPABILITY_DISABLED', message: 'CHECKPOINT_ENABLED 未开启' } });
      return;
    }
    const runId = typeof req.params.runId === 'string' ? req.params.runId : '';
    res.json({ enabled: true, evidence: this.service.getRun(runId) });
  }

  /** POST /checkpoints/runs/:runId/rollback → run 粒度（可带 step / files）。 */
  async rollbackRun(req: Request, res: Response): Promise<void> {
    if (!this.service.enabled) {
      res.status(409).json({ enabled: false, error: { code: 'CAPABILITY_DISABLED', message: 'CHECKPOINT_ENABLED 未开启' } });
      return;
    }
    const rawConfirm = req.headers[ROLLBACK_CONFIRM_HEADER];
    const confirm = Array.isArray(rawConfirm) ? rawConfirm[0] : rawConfirm;
    if (typeof confirm !== 'string' || confirm.trim() !== ROLLBACK_CONFIRM_VALUE) {
      res.status(400).json({
        error: {
          code: 'CONFIRM_HEADER_REQUIRED',
          message: `需要显式头 ${ROLLBACK_CONFIRM_HEADER}: ${ROLLBACK_CONFIRM_VALUE} 以确认回滚`,
        },
      });
      return;
    }
    const runId = typeof req.params.runId === 'string' ? req.params.runId : '';
    const body = (req.body ?? {}) as { step?: unknown; files?: unknown };
    const step = typeof body.step === 'number' ? body.step : undefined;
    const files = Array.isArray(body.files)
      ? body.files.filter((f): f is string => typeof f === 'string')
      : undefined;
    const report = await this.service.restoreRun(runId, { step, files });
    res.json({ enabled: true, report });
  }

  /** POST /checkpoints/:id/pin → 重要节点永久保留（不进 20 run / 200 MB 淘汰）。 */
  pin(req: Request, res: Response): void {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const body = (req.body ?? {}) as { pinned?: unknown };
    const pinned = body.pinned !== false;
    const ok = this.service.pin(id, pinned);
    if (!ok) {
      res.status(404).json({ error: { code: 'CHECKPOINT_NOT_FOUND', message: `快照不存在: ${id}` } });
      return;
    }
    res.json({ ok: true, pinned });
  }
}
