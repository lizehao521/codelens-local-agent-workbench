/**
 * RunState：一次 run 的结构化状态 + 模板化结论。
 *
 * 设计约束：
 * - 只在服务端落「结构化事实」：阶段、工具、审批、文件改动引用、错误/降级、成本。
 * - **不落**工具参数正文、模型输出正文、密钥；工具只保留名称、callId、摘要。
 * - 汇报卡里的每个数字都从 RunState 读，不在收尾时另起一套统计。
 */

import type { Db } from '../../repositories/db.js';
import type {
  RunApprovalRecord,
  RunBudgetRecord,
  RunCostRecord,
  RunCutoffRecord,
  RunErrorRecord,
  RunFileChangeRecord,
  RunOutcome,
  RunReport,
  RunStageName,
  RunStateData,
  RunToolRecord,
} from '../../types/run-state.js';

export interface RunStateStartInput {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  channel: string | null;
}

export interface RunStateServiceOptions {
  /** true = 每轮都出汇报卡；false（默认）= 仅有实质变化时出。 */
  everyRun?: boolean;
  /** 成本触发阈值（prompt+completion）。 */
  costTokenThreshold?: number;
}

const DEFAULT_STATE = (input: RunStateStartInput): RunStateData => ({
  runId: input.runId,
  sessionId: input.sessionId,
  provider: input.provider,
  model: input.model,
  channel: input.channel,
  startedAt: Date.now(),
  endedAt: null,
  status: 'running',
  finishReason: null,
  stages: [],
  tools: [],
  approvals: [],
  fileChanges: [],
  errors: [],
  cost: {
    promptTokens: 0,
    completionTokens: 0,
    reviewPromptTokens: 0,
    reviewCompletionTokens: 0,
    durationMs: 0,
  },
  budget: null,
  cutoff: null,
});

const BUDGET_LABEL: Record<RunBudgetRecord['kind'], string> = {
  iterations: '迭代轮数预算',
  tool_calls: '工具调用预算',
  tokens: 'token 预算',
  wall_clock: '墙钟预算',
};

const BUDGET_STATUS_CODE: Record<RunBudgetRecord['kind'], string> = {
  iterations: 'RUN_BUDGET_ITERATIONS',
  tool_calls: 'RUN_BUDGET_TOOL_CALLS',
  tokens: 'RUN_BUDGET_TOKENS',
  wall_clock: 'RUN_BUDGET_WALL_CLOCK',
};

function budgetUnfinished(budget: RunBudgetRecord): string[] {
  switch (budget.kind) {
    case 'iterations':
      return ['模型未继续生成后续步骤'];
    case 'tool_calls':
      return ['后续计划的工具调用未执行'];
    case 'tokens':
      return ['后续轮次因 token 上限未执行'];
    case 'wall_clock':
      return ['后续轮次因墙钟上限未执行'];
  }
}

export class RunStateService {
  private readonly everyRun: boolean;
  private readonly costTokenThreshold: number;

  constructor(
    private readonly db: Db,
    opts: RunStateServiceOptions = {},
  ) {
    this.everyRun = opts.everyRun === true;
    this.costTokenThreshold = opts.costTokenThreshold ?? 8000;
  }

  start(input: RunStateStartInput): RunStateData {
    const state = DEFAULT_STATE(input);
    this.db.run(
      `INSERT OR REPLACE INTO agent_runs
        (run_id, session_id, status, provider, model, channel, state_json, started_at, ended_at)
       VALUES (?, ?, 'running', ?, ?, ?, ?, ?, NULL)`,
      [input.runId, input.sessionId, input.provider, input.model, input.channel, JSON.stringify(state), state.startedAt],
    );
    return state;
  }

  private read(runId: string): RunStateData | null {
    const row = this.db.get<{ state_json: string }>('SELECT state_json FROM agent_runs WHERE run_id = ?', [runId]);
    if (!row) return null;
    try {
      return JSON.parse(row.state_json) as RunStateData;
    } catch {
      return null;
    }
  }

  private write(state: RunStateData, status?: RunStateData['status'], report?: RunReport): void {
    this.db.run(
      `UPDATE agent_runs SET state_json = ?, status = ?, report_json = ?, ended_at = ? WHERE run_id = ?`,
      [
        JSON.stringify(state),
        status ?? state.status,
        report ? JSON.stringify(report) : null,
        state.endedAt,
        state.runId,
      ],
    );
  }

  stage(runId: string, stage: RunStageName, detail: string | null = null): void {
    const state = this.read(runId);
    if (!state) return;
    const now = Date.now();
    state.stages.push({ stage, at: now, elapsedMs: now - state.startedAt, detail });
    this.write(state);
  }

  tool(runId: string, record: RunToolRecord): void {
    const state = this.read(runId);
    if (!state) return;
    state.tools.push(record);
    this.write(state);
  }

  approval(runId: string, record: RunApprovalRecord): void {
    const state = this.read(runId);
    if (!state) return;
    state.approvals.push(record);
    this.write(state);
  }

  fileChange(runId: string, record: RunFileChangeRecord): void {
    const state = this.read(runId);
    if (!state) return;
    state.fileChanges.push(record);
    this.write(state);
  }

  error(runId: string, record: RunErrorRecord): void {
    const state = this.read(runId);
    if (!state) return;
    state.errors.push(record);
    this.write(state);
  }

  cost(runId: string, cost: Partial<RunCostRecord>): void {
    const state = this.read(runId);
    if (!state) return;
    state.cost = { ...state.cost, ...cost };
    this.write(state);
  }

  addReviewCost(runId: string, promptTokens: number, completionTokens: number): void {
    const state = this.read(runId);
    if (!state) return;
    state.cost.reviewPromptTokens += promptTokens;
    state.cost.reviewCompletionTokens += completionTokens;
    this.write(state);
  }

  /** A：记录触顶的那一道预算（先于 finish 调用，保证 cutoff 能读到）。 */
  budget(runId: string, record: RunBudgetRecord): void {
    const state = this.read(runId);
    if (!state) return;
    state.budget = record;
    this.write(state);
  }

  /**
   * 收尾：无论正常/错误/中止都走这里；返回的 report 是唯一对外结论来源。
   */
  finish(
    runId: string,
    status: RunStateData['status'],
    finishReason: string | null,
    usage: { promptTokens: number; completionTokens: number },
    /** 收尾原因的可读细节（如 context_full 的压缩自检失败项）；仅用于报告 reason 兜底。 */
    detail?: string | null,
  ): RunReport | null {
    const state = this.read(runId);
    if (!state) return null;
    const endedAt = Date.now();
    state.endedAt = endedAt;
    state.status = status;
    state.finishReason = finishReason;
    state.cost.promptTokens = usage.promptTokens;
    state.cost.completionTokens = usage.completionTokens;
    state.cost.durationMs = endedAt - state.startedAt;

    // A：收尾截止点 —— 从 RunState 自身事实推导，不另起统计。
    const budget = state.budget;
    const lastStage = state.stages[state.stages.length - 1];
    const cutoff: RunCutoffRecord = {
      lastStage: lastStage?.stage ?? null,
      completedToolCalls: state.tools.length,
      completedFileChanges: state.fileChanges.length,
      unfinished: budget ? budgetUnfinished(budget) : [],
    };
    state.cutoff = cutoff;

    const report = this.buildReport(state, detail);
    this.write(state, status, report);
    return report;
  }

  /** A：终态码与完成态严格分离（预算耗尽不得冒充完成）。 */
  private resolveOutcome(state: RunStateData): { outcome: RunOutcome; statusCode: string } {
    const reason = state.finishReason;
    if (state.budget) {
      return { outcome: 'budget_exhausted', statusCode: BUDGET_STATUS_CODE[state.budget.kind] };
    }
    if (reason === 'converged') return { outcome: 'converged', statusCode: 'RUN_CONVERGED' };
    if (reason === 'aborted') return { outcome: 'aborted', statusCode: 'RUN_ABORTED' };
    if (state.status === 'error') return { outcome: 'error', statusCode: 'RUN_ERROR' };
    return { outcome: 'completed', statusCode: 'RUN_COMPLETED' };
  }

  /** A：预算耗尽时的一句话原因（哪道预算、第几步、已做什么、没做什么）。 */
  private budgetReason(state: RunStateData, budget: RunBudgetRecord): string {
    const done: string[] = [];
    if (state.tools.length > 0) done.push(`已完成 ${state.tools.length} 次工具调用`);
    if (state.fileChanges.length > 0) {
      done.push(`改动 ${new Set(state.fileChanges.map((f) => f.path)).size} 个文件`);
    }
    if (done.length === 0) done.push('未产生工具调用与文件改动');
    const unit = budget.kind === 'wall_clock' ? 'ms' : budget.kind === 'tokens' ? 'token' : '次';
    const todo = state.cutoff?.unfinished.length ? state.cutoff.unfinished.join('、') : '后续步骤未执行';
    return `${BUDGET_LABEL[budget.kind]}在第 ${budget.atStep} 步触发（${budget.used}/${budget.limit} ${unit}）；已做：${done.join('、')}；未做：${todo}`;
  }

  buildReport(state: RunStateData, detail?: string | null): RunReport {
    const triggers: string[] = [];
    const irreversibleCount = state.tools.filter((t) => t.effectReversible === false).length;
    const totalTokens = state.cost.promptTokens + state.cost.completionTokens
      + state.cost.reviewPromptTokens + state.cost.reviewCompletionTokens;

    if (state.fileChanges.length > 0) triggers.push('文件改动');
    if (irreversibleCount > 0) triggers.push('不可逆操作');
    if (state.approvals.length > 0) triggers.push('审批');
    if (state.errors.length > 0) triggers.push('错误/降级');
    if (totalTokens >= this.costTokenThreshold) triggers.push('成本超阈值');
    if (state.status === 'error' || state.status === 'aborted') {
      // context_full 的 reason 已经写明「上下文已满…安全回退」，再挂通用「异常终止」
      // 会在同一张卡上出现互相冲突的措辞。换成同义但准确的标签，且保持 triggers
      // 非空 —— 否则 hasMaterialChange 变 false，汇报卡反而整个不显示。
      triggers.push(state.finishReason === 'context_full' ? '上下文已满' : '异常终止');
    }
    if (state.budget) triggers.push('预算耗尽');
    if (state.finishReason === 'converged') triggers.push('收敛判定');

    const hasMaterialChange = this.everyRun || triggers.length > 0;
    const { outcome, statusCode } = this.resolveOutcome(state);
    const reason = state.budget
      ? this.budgetReason(state, state.budget)
      : state.finishReason === 'converged'
        ? '连续多轮无新增文件改动 / 证据 / 工具结果变化，我判断已到头'
        : state.finishReason === 'context_full'
          ? detail?.trim() ||
            '上下文已满：压缩自检未通过，任务已安全回退（未把超窗对话继续发给模型）。建议：新建会话，或把任务拆小后重试'
          : null;
    const notDone = state.cutoff?.unfinished ?? [];
    const durationMs = state.cost.durationMs;
    const seconds = (durationMs / 1000).toFixed(1);
    const parts: string[] = [];
    if (state.fileChanges.length > 0) {
      const files = new Set(state.fileChanges.map((f) => f.path)).size;
      parts.push(`改动 ${files} 个文件（${state.fileChanges.length} 次写入）`);
    }
    if (irreversibleCount > 0) parts.push(`不可逆操作 ${irreversibleCount} 次`);
    if (state.approvals.length > 0) parts.push(`审批 ${state.approvals.length} 次`);
    if (state.errors.length > 0) parts.push(`错误/降级 ${state.errors.length} 次`);
    if (state.tools.length > 0) parts.push(`工具调用 ${state.tools.length} 次`);
    parts.push(`耗时 ${seconds}s`);
    parts.push(`token ${totalTokens}（复核 ${state.cost.reviewPromptTokens + state.cost.reviewCompletionTokens}）`);

    return {
      runId: state.runId,
      sessionId: state.sessionId,
      outcome,
      statusCode,
      reason,
      notDone,
      hasMaterialChange,
      triggers,
      finishReason: state.finishReason,
      fileChangeCount: new Set(state.fileChanges.map((f) => f.path)).size,
      irreversibleCount,
      approvalCount: state.approvals.length,
      errorCount: state.errors.length,
      toolCallCount: state.tools.length,
      promptTokens: state.cost.promptTokens,
      completionTokens: state.cost.completionTokens,
      durationMs,
      summary: parts.join('；'),
    };
  }

  get(runId: string): RunStateData | null {
    return this.read(runId);
  }

  getReport(runId: string): RunReport | null {
    const row = this.db.get<{ report_json: string | null }>('SELECT report_json FROM agent_runs WHERE run_id = ?', [runId]);
    if (!row?.report_json) return null;
    try {
      return JSON.parse(row.report_json) as RunReport;
    } catch {
      return null;
    }
  }

  list(sessionId: string, limit = 50): Array<{ runId: string; status: string; startedAt: number; summary: string | null }> {
    return this.db
      .all<{ run_id: string; status: string; started_at: number; report_json: string | null }>(
        `SELECT run_id, status, started_at, report_json FROM agent_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT ?`,
        [sessionId, limit],
      )
      .map((row) => {
        let summary: string | null = null;
        if (row.report_json) {
          try {
            summary = (JSON.parse(row.report_json) as RunReport).summary;
          } catch {
            summary = null;
          }
        }
        return { runId: row.run_id, status: row.status, startedAt: row.started_at, summary };
      });
  }
}
