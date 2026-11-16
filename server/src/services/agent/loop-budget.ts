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
  retriesUsed: number;     // task-level auto-retries consumed (budget 5)
  maxRetries: number;
  startedAt: number;
  totalBudgetMs: number;   // 180s task total
  tokenBudget: number;     // task total token cap (prompt+completion), derived from context window
  /** 自适应软上限：达到 tokenBudget 后可逐级扩展到这里；缺省等于 tokenBudget。 */
  tokenBudgetMax?: number;
  /** 每次扩展的步长（通常为一个上下文窗口）；0/缺省 = 不扩展。 */
  tokenBudgetStep?: number;
  /** 任务累计工具调用次数（每轮 executeBatch 后累加）。 */
  toolCallsUsed: number;
  /** 工具调用总次数上限；默认 40（12 轮 × 平均 3 次 + 余量）。 */
  maxToolCalls: number;
  aborted: boolean;
}

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
    retriesUsed: 0,
    maxRetries: DEFAULT_MAX_RETRIES,
    startedAt: Date.now(),
    totalBudgetMs: TASK_BUDGET_MS,
    tokenBudget: UNLIMITED_TOKEN_BUDGET,
    tokenBudgetMax: UNLIMITED_TOKEN_BUDGET,
    tokenBudgetStep: 0,
    toolCallsUsed: 0,
    maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
    aborted: false,
    ...overrides,
  };
}

export function canRetry(state: BudgetState): boolean {
  return state.retriesUsed < state.maxRetries;
}

/**
 * token 预算自适应：命中当前软上限后，按 step 扩到硬上限。
 * 只在「有明确上限 + 有步长 + 还没到硬顶」时扩展；返回 null 表示不扩展。
 */
export function extendTokenBudget(
  state: BudgetState,
  usedTokens: number,
): { from: number; to: number } | null {
  const max = state.tokenBudgetMax ?? state.tokenBudget;
  const step = state.tokenBudgetStep ?? 0;
  if (state.tokenBudget === UNLIMITED_TOKEN_BUDGET || usedTokens < state.tokenBudget) return null;
  if (step <= 0 || max <= state.tokenBudget) return null;
  const to = Math.min(max, state.tokenBudget + step);
  if (to <= state.tokenBudget) return null;
  const from = state.tokenBudget;
  state.tokenBudget = to;
  return { from, to };
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

  return { kind: 'continue' };
}

export function circuitOpenTermination(toolName: string): Termination {
  return { kind: 'stop', finishReason: 'circuit_open', detail: `工具 ${toolName} 已熔断` };
}
