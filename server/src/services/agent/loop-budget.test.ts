/**
 * Unit tests for loop-budget.
 *
 * Iteration count, token usage and wall-clock time are not stopping conditions.
 * The remaining task budgets are abort, tool-call count and the retry helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_RETRIES,
  createBudget,
  canRetry,
  consumeRetry,
  checkTermination,
  circuitOpenTermination,
} from './loop-budget.js';

describe('loop-budget · constants & helpers', () => {
  it('documents the 5 retry budget', () => {
    expect(DEFAULT_MAX_RETRIES).toBe(5);
  });

  it('createBudget fills documented defaults', () => {
    const b = createBudget();
    expect(b.iteration).toBe(0);
    expect(b.maxRetries).toBe(5);
    expect(b.aborted).toBe(false);
  });

  it('createBudget honours overrides', () => {
    const b = createBudget({ aborted: true });
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

describe('loop-budget · checkTermination', () => {
  it('continues when no remaining limit is met', () => {
    expect(checkTermination(createBudget()).kind).toBe('continue');
  });

  it('does not stop on iteration count, token usage or wall-clock time', () => {
    const b = createBudget({ iteration: 1000, tokenBudget: 1, startedAt: Date.now() - 10_000_000 });
    expect(checkTermination(b, 999_999).kind).toBe('continue');
  });

  it('stops on user abort', () => {
    const t = checkTermination(createBudget({ aborted: true }));
    expect(t.kind).toBe('stop');
    if (t.kind === 'stop') expect(t.finishReason).toBe('aborted');
  });

  it('does not stop when the tool-call count is large', () => {
    expect(checkTermination(createBudget({ iteration: 3, maxToolCalls: 40 }), 0, 40).kind).toBe('continue');
  });

  it('金丝雀：工具调用 39/40 时同样继续', () => {
    expect(checkTermination(createBudget({ iteration: 3, maxToolCalls: 40 }), 0, 39).kind).toBe('continue');
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
