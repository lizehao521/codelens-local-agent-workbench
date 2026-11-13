/**
 * Runs controller — 结构化 run 状态与汇报卡的查询面。
 *
 *  - GET /runs/:runId → { state, report }
 *  - GET /runs?sessionId=&limit= → { runs }
 *
 * RunState 里**不含**凭证：start() 只落 provider/model/channel 与计数，
 * 不含 key/baseUrl。API 因此无需额外脱敏，但也不返回 state_json 原文以外的
 * 任何内部字段。
 */

import type { Request, Response } from 'express';
import type { RunStateService } from '../services/agent/run-state.service.js';
import type { CheckpointService, RunEvidenceStep } from '../services/tx/checkpoint.service.js';
import type { RunResumeService } from '../services/agent/run-resume.service.js';

export class RunsController {
  constructor(
    private readonly service: RunStateService,
    private readonly checkpoints: CheckpointService,
    private readonly resumeService: RunResumeService,
  ) {}

  get(req: Request, res: Response): void {
    const runId = typeof req.params.runId === 'string' ? req.params.runId : '';
    const state = this.service.get(runId);
    if (!state) {
      res.status(404).json({ error: { code: 'RUN_NOT_FOUND', message: `run 不存在: ${runId}` } });
      return;
    }
    res.json({ state, report: this.service.getReport(runId) });
  }

  /**
   * D：审计台数据面。diff 全部来自 checkpoint 落库的 diff_json（历史快照），
   * 绝不用当前磁盘重算；每条 hunk 带 step / toolCallIds / checkpointId，
   * 供前端反向跳到审批、复核与快照版本。
   */
  audit(req: Request, res: Response): void {
    const runId = typeof req.params.runId === 'string' ? req.params.runId : '';
    const state = this.service.get(runId);
    const evidence = this.checkpoints.getRun(runId);
    if (!state && evidence.steps.length === 0) {
      res.status(404).json({ error: { code: 'RUN_NOT_FOUND', message: `run 不存在: ${runId}` } });
      return;
    }

    const steps: RunEvidenceStep[] = evidence.steps;
    // 每条 hunk 反向标注来源（第几步 / 哪次调用 / 哪个快照），前端据此可跳回审批与复核。
    const attributedSteps = steps.map((s) => ({
      ...s,
      files: s.files.map((f) => ({
        ...f,
        step: s.step,
        checkpointId: s.checkpointId,
        toolCallIds: s.toolCallIds,
      })),
    }));
    const files = [...new Set(steps.flatMap((s) => s.files.map((f) => f.path)))].map((path) => {
      const history = steps
        .filter((s) => s.files.some((f) => f.path === path))
        .map((s) => ({
          step: s.step,
          checkpointId: s.checkpointId,
          status: s.status,
          restoredAt: s.restoredAt,
          toolCallIds: s.toolCallIds,
        }));
      // 以最后一次出现的 operation 为准：create 之后又 write 仍算「新增」，
      // 因为 before 始终为空，撤销语义是删掉整个 run 建出来的文件。
      const lastOp = steps
        .filter((s) => s.files.some((f) => f.path === path))
        .flatMap((s) => s.files.filter((f) => f.path === path))
        .pop()?.operation;
      return { path, operation: lastOp ?? 'write', steps: history };
    });

    res.json({
      runId,
      report: this.service.getReport(runId),
      budget: state?.budget ?? null,
      cost: state?.cost ?? null,
      stages: state?.stages ?? [],
      approvals: state?.approvals ?? [],
      files,
      steps: attributedSteps,
      fileCount: evidence.fileCount,
      totalBytes: evidence.totalBytes,
      undo: {
        runAvailable: steps.some((s) => s.status === 'active'),
        activeSnapshots: steps.filter((s) => s.status === 'active').length,
      },
    });
  }

  /** C：按 runId 续跑；冲突时 409 + 冲突清单，且不写盘。 */
  async resume(req: Request, res: Response): Promise<void> {
    const runId = typeof req.params.runId === 'string' ? req.params.runId : '';
    const result = await this.resumeService.precheck(runId);
    if (result.status === 'not_found') {
      res.status(404).json({
        status: result.status,
        error: { code: 'RUN_NOT_FOUND', message: `run 不存在: ${runId}` },
      });
      return;
    }
    if (result.status === 'conflict') {
      res.status(409).json({ status: result.status, runId, conflicts: result.conflicts });
      return;
    }
    if (result.status === 'not_resumable') {
      res.status(409).json({ status: result.status, runId, reason: result.reason });
      return;
    }
    res.json(result);
  }

  list(req: Request, res: Response): void {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    if (!sessionId) {
      res.status(400).json({ error: { code: 'SESSION_REQUIRED', message: '需要 sessionId 查询 run 列表' } });
      return;
    }
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
    res.json({ runs: this.service.list(sessionId, limit) });
  }
}
