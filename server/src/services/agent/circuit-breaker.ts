/**
 * Circuit breaker (AC-08): a tool that fails 3 consecutive times opens the
 * circuit — the 4th call returns circuit_open WITHOUT any LLM involvement.
 * One success resets the counter. Pure state, keyed by canonical tool name.
 */

export type BreakerVerdict = { open: false } | { open: true; message: string };

const FAILURE_THRESHOLD = 3;

export class CircuitBreaker {
  private readonly failures = new Map<string, number>();

  /** Must be called before executing a tool. */
  check(toolName: string): BreakerVerdict {
    const count = this.failures.get(toolName) ?? 0;
    if (count >= FAILURE_THRESHOLD) {
      return {
        open: true,
        message: `工具 ${toolName} 连续失败 ${count} 次，已熔断。请更换工具或调整参数后重试。`,
      };
    }
    return { open: false };
  }

  recordSuccess(toolName: string): void {
    this.failures.delete(toolName);
  }

  /** Only 'failed' and 'timeout' count — rejected/skipped do not (AC-03/D-6). */
  recordFailure(toolName: string): void {
    this.failures.set(toolName, (this.failures.get(toolName) ?? 0) + 1);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.failures);
  }
}
