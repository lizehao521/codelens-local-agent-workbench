/**
 * Unit tests for loop-budget (perf-report H-P2 recommended coverage).
 *
 * The loop feeds this pure state machine observations and asks "continue or
 * stop". The contract under test: a long task under the 12-iteration default
 * cap must STOP and emit an "unfinished work" summary — never silently
 * truncate (fail-closed). Token/time budgets and the abort path are also
 * covered, plus the retry budget helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_RETRIES,
  TASK_BUDGET_MS,
  UNLIMITED_TOKEN_BUDGET,
  deriveTokenBudget,
  createBudget,
  canRetry,
  consumeRetry,
  checkTermination,
  circuitOpenTermination,
} from './loop-budget.js';

describe('loop-budget · constants & helpers', () => {
  it('documents the 12-iteration default cap (H-P2)', () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(12);
  });

  it('documents the 5 retry budget', () => {
    expect(DEFAULT_MAX_RETRIES).toBe(5);
  });

  it('documents the 180s task budget', () => {
    expect(TASK_BUDGET_MS).toBe(180_000);
  });

  it('deriveTokenBudget returns UNLIMITED for non-positive / non-finite windows', () => {
    expect(deriveTokenBudget(0)).toBe(UNLIMITED_TOKEN_BUDGET);
    expect(deriveTokenBudget(-1)).toBe(UNLIMITED_TOKEN_BUDGET);
    expect(deriveTokenBudget(NaN)).toBe(UNLIMITED_TOKEN_BUDGET);
  });

  it('deriveTokenBudget = window * 2 for a valid window', () => {
    expect(deriveTokenBudget(100_000)).toBe(200_000);
  });

  it('createBudget fills documented defaults', () => {
    const b = createBudget();
    expect(b.iteration).toBe(0);
    expect(b.maxIterations).toBe(12);
    expect(b.maxRetries).toBe(5);
    expect(b.aborted).toBe(false);
  });

  it('createBudget honours overrides', () => {
    const b = createBudget({ maxIterations: 5, aborted: true });
    expect(b.maxIterations).toBe(5);
    expect(b.aborted).toBe(true);
  });
});

describe('loop-budget · retry budget helpers', () => {
  it('canRetry is true while under the cap', () => {
    expect(canRetry(createBudget({ retriesUsed: 0, maxRetries: 5 }))).toBe(true);
  });

  it('canRetry is false exactly at the cap', () => {
    expect(canRetry(createBudget({ retriesUsed: 5, maxRetries: 5 }))).toBe(false);
  });

  it('consumeRetry increments the used counter', () => {
    const b = createBudget({ retriesUsed: 0, maxRetries: 5 });
    consumeRetry(b);
    expect(b.retriesUsed).toBe(1);
  });
});

describe('loop-budget · checkTermination continue path', () => {
  it('continues when every limit is unmet', () => {
    expect(checkTermination(createBudget()).kind).toBe('continue');
  });
});

describe('loop-budget · checkTermination stop reasons (H-P2 fail-closed)', () => {
  it('stops at max_iterations exactly on the boundary (iteration === maxIterations)', () => {
    const t = checkTermination(createBudget({ iteration: 12, maxIterations: 12 }));
    expect(t.kind).toBe('stop');
    if (t.kind === 'stop') {
      expect(t.finishReason).toBe('max_iterations');
      expect(t.detail).toContain('最大迭代轮数');
    }
  });

  it('continues one step below the cap (iteration 11 < 12)', () => {
    expect(checkTermination(createBudget({ iteration: 11, maxIterations: 12 })).kind).toBe('continue');
  });

  it('stops when the token budget is exhausted', () => {
    const t = checkTermination(createBudget({ tokenBudget: 1000, iteration: 1 }), 1000);
    expect(t.kind).toBe('stop');
    if (t.kind === 'stop') expect(t.finishReason).toBe('budget_exhausted');
  });

  it('continues when usedTokens is just under the token budget', () => {
    expect(checkTermination(createBudget({ tokenBudget: 1000, iteration: 1 }), 999).kind).toBe('continue');
  });

  it('stops when the wall-clock budget is exhausted', () => {
    const t = checkTermination(
      createBudget({ startedAt: Date.now() - (TASK_BUDGET_MS + 1000), totalBudgetMs: TASK_BUDGET_MS }),
    );
    expect(t.kind).toBe('stop');
    if (t.kind === 'stop') expect(t.finishReason).toBe('budget_exhausted');
  });

  it('stops on user abort', () => {
    const t = checkTermination(createBudget({ aborted: true }));
    expect(t.kind).toBe('stop');
    if (t.kind === 'stop') expect(t.finishReason).toBe('aborted');
  });

  it('abort takes precedence over the iteration cap when both are set', () => {
    const t = checkTermination(createBudget({ aborted: true, iteration: 12, maxIterations: 12 }));
    if (t.kind === 'stop') expect(t.finishReason).toBe('aborted');
  });

  it('stops when the tool-call budget is exhausted and reports kind/step', () => {
    const t = checkTermination(createBudget({ iteration: 3, maxToolCalls: 40 }), 0, 40);
    expect(t.kind).toBe('stop');
    if (t.kind === 'stop') {
      expect(t.finishReason).toBe('budget_exhausted');
      expect(t.budget).toEqual({ kind: 'tool_calls', limit: 40, used: 40, atStep: 3 });
      expect(t.detail).toContain('工具调用预算');
    }
  });

  it('金丝雀：工具调用 39/40 时不得走收尾路径', () => {
    expect(checkTermination(createBudget({ iteration: 3, maxToolCalls: 40 }), 0, 39).kind).toBe('continue');
  });

  it('token / wall-clock 命中时都带 budget 元数据（可被汇报卡消费）', () => {
    const token = checkTermination(createBudget({ tokenBudget: 1000, iteration: 2 }), 1000, 0);
    if (token.kind === 'stop') expect(token.budget).toMatchObject({ kind: 'tokens', limit: 1000, used: 1000 });
    const wall = checkTermination(
      createBudget({ startedAt: Date.now() - (TASK_BUDGET_MS + 1000), totalBudgetMs: TASK_BUDGET_MS, iteration: 1 }),
    );
    if (wall.kind === 'stop') expect(wall.budget).toMatchObject({ kind: 'wall_clock', atStep: 1 });
  });

  it('迭代上限同样带 iterations 元数据', () => {
    const t = checkTermination(createBudget({ iteration: 12, maxIterations: 12 }));
    if (t.kind === 'stop') expect(t.budget).toMatchObject({ kind: 'iterations', limit: 12, used: 12, atStep: 12 });
  });
});

describe('loop-budget · circuitOpenTermination', () => {
  it('returns stop with circuit_open and names the tool', () => {
    const t = circuitOpenTermination('sys.exec');
    expect(t.kind).toBe('stop');
    if (t.kind === 'stop') {
      expect(t.finishReason).toBe('circuit_open');
      expect(t.detail).toContain('sys.exec');
    }
  });
});
