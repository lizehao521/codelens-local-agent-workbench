/**
 * Loop budget and termination (architecture 4.4, 7.5): T-1..T-5.
 * Pure state machine: the loop feeds it observations, it answers "continue or stop".
 *
 * 四道预算（A 轮）：迭代数 / 工具调用总次数 / 累计 token / 墙钟。
 * 任一触顶都返回 stop + `budget` 记录（哪一道、上限、已用、第几步），
 * 由调用方先写 RunState 终态再收尾 —— **不抛错**。
 */

export type BudgetKind = 'iterations' | 'tool_calls' | 'tokens' | 'wall_clock';

export interface BudgetHit {
  kind: BudgetKind;
  /** 该道预算的上限。 */
  limit: number;
  /** 触发时已用量。 */
  used: number;
  /** 触发时已完成的轮次（0 = 首轮之前）。 */
  atStep: number;
}

export type Termination =
  | { kind: 'continue' }
  | {
      kind: 'stop';
      finishReason: 'stop' | 'max_iterations' | 'budget_exhausted' | 'aborted' | 'circuit_open';
      detail: string;
      budget?: BudgetHit;
    };

export interface BudgetState {
  iteration: number;       // LLM calls made so far (1-based when running)
  maxIterations: number;   // 5-30, default 12
  retriesUsed: number;     // task-level auto-retries consumed (budget 5)
  maxRetries: number;
  startedAt: number;
  totalBudgetMs: number;   // 180s task total
  tokenBudget: number;     // task total token cap (prompt+completion), derived from context window
  /** 任务累计工具调用次数（每轮 executeBatch 后累加）。 */
  toolCallsUsed: number;
  /** 工具调用总次数上限；默认 40（12 轮 × 平均 3 次 + 余量）。 */
  maxToolCalls: number;
  aborted: boolean;
}

export const DEFAULT_MAX_ITERATIONS = 12;
export const DEFAULT_MAX_RETRIES = 5;
/** 180s：本地/远端首字节常 5–20s；正常 12 轮任务实测多在 60–150s。 */
export const TASK_BUDGET_MS = 180_000;
/** token 硬顶 = 上下文窗口 × 2（允许跨多轮的正常工作，同时防失控跑满）。 */
export const TOKEN_BUDGET_CONTEXT_FACTOR = 2;
/** 默认工具调用总次数上限：12 轮 × 平均 3 次 ≈ 36，留 4 次余量。 */
export const DEFAULT_MAX_TOOL_CALLS = 40;
/** 未从上下文窗口推导时默认不启用 token 硬顶（软闸）。 */
export const UNLIMITED_TOKEN_BUDGET = Number.MAX_SAFE_INTEGER;

export function deriveTokenBudget(contextWindow: number, factor = TOKEN_BUDGET_CONTEXT_FACTOR): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return UNLIMITED_TOKEN_BUDGET;
  return Math.max(1, Math.floor(contextWindow * factor));
}

export function createBudget(overrides: Partial<BudgetState> = {}): BudgetState {
  return {
    iteration: 0,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    retriesUsed: 0,
    maxRetries: DEFAULT_MAX_RETRIES,
    startedAt: Date.now(),
    totalBudgetMs: TASK_BUDGET_MS,
    tokenBudget: UNLIMITED_TOKEN_BUDGET,
    toolCallsUsed: 0,
    maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
    aborted: false,
    ...overrides,
  };
}

export function canRetry(state: BudgetState): boolean {
  return state.retriesUsed < state.maxRetries;
}

export function consumeRetry(state: BudgetState): void {
  state.retriesUsed += 1;
}

/** Called before each LLM call. `usedTokens` = 任务累计 prompt+completion。 */
export function checkTermination(
  state: BudgetState,
  usedTokens = 0,
  usedToolCalls = state.toolCallsUsed,
): Termination {
  if (state.aborted) return { kind: 'stop', finishReason: 'aborted', detail: '用户中止了任务' };

  if (state.iteration >= state.maxIterations) {
    return {
      kind: 'stop',
      finishReason: 'max_iterations',
      detail: `已达最大迭代轮数 ${state.maxIterations}，基于已完成的结果输出总结`,
      budget: {
        kind: 'iterations',
        limit: state.maxIterations,
        used: state.iteration,
        atStep: state.iteration,
      },
    };
  }

  if (usedToolCalls >= state.maxToolCalls) {
    return {
      kind: 'stop',
      finishReason: 'budget_exhausted',
      detail: `工具调用预算已用尽（${usedToolCalls}/${state.maxToolCalls}），基于已完成的结果输出总结`,
      budget: {
        kind: 'tool_calls',
        limit: state.maxToolCalls,
        used: usedToolCalls,
        atStep: state.iteration,
      },
    };
  }

  if (state.tokenBudget !== UNLIMITED_TOKEN_BUDGET && usedTokens >= state.tokenBudget) {
    return {
      kind: 'stop',
      finishReason: 'budget_exhausted',
      detail: `任务 token 预算已用尽（${state.tokenBudget}）`,
      budget: {
        kind: 'tokens',
        limit: state.tokenBudget,
        used: usedTokens,
        atStep: state.iteration,
      },
    };
  }

  const elapsed = Date.now() - state.startedAt;
  if (elapsed >= state.totalBudgetMs) {
    return {
      kind: 'stop',
      finishReason: 'budget_exhausted',
      detail: `任务墙钟预算（${state.totalBudgetMs}ms）已用尽`,
      budget: {
        kind: 'wall_clock',
        limit: state.totalBudgetMs,
        used: elapsed,
        atStep: state.iteration,
      },
    };
  }

  return { kind: 'continue' };
}

export function circuitOpenTermination(toolName: string): Termination {
  return { kind: 'stop', finishReason: 'circuit_open', detail: `工具 ${toolName} 已熔断` };
}
