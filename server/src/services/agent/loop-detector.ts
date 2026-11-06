/**
 * Loop detector (AC-08 / architecture 7.5): identical (tool, argument digest)
 * calls repeat detection. 2 consecutive → inject a warning observation;
 * 3 consecutive → abort the task. Pure functions over an ordered call log.
 */

import { callSignature } from '../../utils/digest.js';

export type LoopVerdict =
  | { kind: 'ok' }
  | { kind: 'warn'; message: string }
  | { kind: 'abort'; message: string };

export class LoopDetector {
  private readonly history: string[] = [];
  private streak = 0;

  /** Records one executed call and returns the verdict for it. */
  record(toolName: string, args: Record<string, unknown>): LoopVerdict {
    const signature = callSignature(toolName, args);
    this.history.push(signature);
    if (this.history.length >= 2 && this.history[this.history.length - 2] === signature) {
      this.streak += 1;
    } else {
      this.streak = 1;
    }
    if (this.streak >= 3) {
      return {
        kind: 'abort',
        message: `检测到同一调用连续重复 ${this.streak} 次，任务中止。可尝试「从该步重跑」或更换参数/工具。`,
      };
    }
    if (this.streak === 2) {
      return {
        kind: 'warn',
        message: '你正在重复同一个调用，请换参数或换工具。',
      };
    }
    return { kind: 'ok' };
  }

  get consecutive(): number {
    return this.streak;
  }
}
