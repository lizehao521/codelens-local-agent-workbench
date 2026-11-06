/**
 * B：收敛判据（治空转）。
 *
 * 判据只吃 RunState 的真实差异：本轮新增文件改动数 + 本轮工具结果摘要的 digest。
 * 连续 N 轮三者（文件改动 / 证据 / 工具结果）都没有变化 → 判收敛。
 * 不使用模型自述；任何一轮出现写入或结果变化都会把计数清零。
 */

import { createHash } from 'node:crypto';
import type { RunStateData } from '../../types/run-state.js';

export interface RoundSignature {
  /** 本轮新增的文件改动数（来自 RunState.fileChanges 的切片差值）。 */
  filesDelta: number;
  /** 本轮工具结果（callId + status + summary）的摘要。 */
  resultDigest: string;
}

export interface ConvergenceVerdict {
  streak: number;
  converged: boolean;
}

/** 从 RunState 的相邻快照差集生成本轮签名（不读模型输出）。 */
export function buildRoundSignature(
  state: Pick<RunStateData, 'tools' | 'fileChanges'>,
  toolOffset: number,
  fileOffset: number,
): RoundSignature {
  const newTools = state.tools.slice(Math.max(0, toolOffset));
  const filesDelta = Math.max(0, state.fileChanges.length - Math.max(0, fileOffset));
  const payload = newTools
    .map((t) => `${t.callId}:${t.name}:${t.status}:${t.resultSummary ?? ''}:${t.errorCode ?? ''}`)
    .join('|');
  return {
    filesDelta,
    resultDigest: digest(payload),
  };
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export class ConvergenceDetector {
  private last: RoundSignature | null = null;
  private streakCount = 0;
  /** 上一轮是否已被判为「有变化」。有变化轮作为新基线，不参与 digest 比较。 */
  private lastChanged = false;

  constructor(private readonly threshold: number) {}

  /**
   * 记录一轮签名。
   * - 首轮：无前值可比；本轮无改动记 1 轮，有改动记 0。
   * - 后续：文件改动 > 0 或结果 digest 变化 → 计数清零；否则 +1。
   * - threshold <= 0 时永不判收敛（关闭）。
   */
  record(signature: RoundSignature): ConvergenceVerdict {
    const previous = this.last;
    this.last = signature;

    let changed: boolean;
    if (!previous) {
      changed = signature.filesDelta > 0;
      this.streakCount = changed ? 0 : 1;
    } else {
      // 上一轮若已「有变化」，本轮摘要变化属于该变化的后续，不作为新的变化。
      changed =
        signature.filesDelta > 0 ||
        (!this.lastChanged && signature.resultDigest !== previous.resultDigest);
      this.streakCount = changed ? 0 : this.streakCount + 1;
    }
    this.lastChanged = changed;

    const converged = this.threshold > 0 && this.streakCount >= this.threshold;
    return { streak: this.streakCount, converged };
  }
}
