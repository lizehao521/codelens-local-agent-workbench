/**
 * C：按 runId 断点续跑（薄服务，复用既有 checkpoint + RunState + rewind）。
 *
 * 续跑前强校验：每个已改动文件的磁盘 sha256 必须等于 run 记录的 after。
 * 不一致 → 返回冲突清单并拒绝续跑；绝不静默续跑、绝不覆盖用户改动。
 */

import type { RunConflict } from '../tx/checkpoint.service.js';
import type { CheckpointService } from '../tx/checkpoint.service.js';
import type { RunStateService } from './run-state.service.js';

export interface ResumePlan {
  runId: string;
  sessionId: string;
  /** 最后一步的第一条工具调用；null 表示该 run 还没有工具调用。 */
  resumeFromCallId: string | null;
  /** 将要重做的步骤号（最后一步）。 */
  step: number | null;
}

export type ResumeResult =
  | { status: 'ok'; plan: ResumePlan }
  | { status: 'conflict'; conflicts: RunConflict[] }
  | { status: 'not_found' }
  | { status: 'not_resumable'; reason: string };

export class RunResumeService {
  constructor(
    private readonly runState: RunStateService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async precheck(runId: string): Promise<ResumeResult> {
    const state = this.runState.get(runId);
    if (!state) return { status: 'not_found' };

    // 文件完整性优先于可续跑性：先给用户明确的冲突清单。
    const integrity = await this.checkpoints.verifyRun(runId);
    if (!integrity.ok) return { status: 'conflict', conflicts: integrity.conflicts };

    if (state.status !== 'running') {
      return { status: 'not_resumable', reason: `run 已结束（${state.status}），无需续跑` };
    }

    // 以「最后一步之前」为界：重做最后一步，不重放更早的已完成调用。
    const lastStep = state.tools.reduce<number | null>(
      (max, tool) => (max == null || tool.iteration > max ? tool.iteration : max),
      null,
    );
    const firstOfLastStep =
      lastStep == null
        ? null
        : state.tools.find((tool) => tool.iteration === lastStep)?.callId ?? null;

    return {
      status: 'ok',
      plan: {
        runId,
        sessionId: state.sessionId,
        resumeFromCallId: firstOfLastStep,
        step: lastStep,
      },
    };
  }
}
