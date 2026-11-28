/**
 * B：收敛判据（治空转）。
 *
 * 判据只吃 RunState 的真实差异：本轮新增文件改动数 + 本轮工具结果摘要的 digest。
 * 连续 N 轮三者（文件改动 / 证据 / 工具结果）都没有变化 → 判收敛。
 * 不使用模型自述；任何一轮出现写入或结果变化都会把计数清零。
 */

import { createHash } from 'node:crypto';
import type { RunStateData } from '../../types/run-state.js';

/** 单工具失败态白名单：RunToolRecord.status 中视为失败的值（不含 'aborted'，那是 RunState 整体状态）。 */
const FAILED_TOOL_STATUSES = new Set<RunStateData['tools'][number]['status']>(['failed', 'timeout', 'rejected', 'skipped']);

export interface RoundSignature {
  /** 本轮新增的文件改动数（来自 RunState.fileChanges 的切片差值）。 */
  filesDelta: number;
  /** 本轮工具结果（name + status + summary + errorCode，不含 callId）的摘要。 */
  resultDigest: string;
  /** 本轮工具调用是否全部失败（status 在失败态白名单内 或 存在 errorCode）。 */
  allFailed: boolean;
  /** 本轮无信号：无新工具 且 无文件改动。此类轮次不应累加收敛计数。 */
  hasNoSignal: boolean;
}

export interface ConvergenceVerdict {
  streak: number;
  converged: boolean;
}

/** 判定某工具记录是否为失败态：status 在失败态白名单内 或 存在 errorCode。 */
function isFailedTool(t: Pick<RunStateData['tools'][number], 'status' | 'errorCode'>): boolean {
  return FAILED_TOOL_STATUSES.has(t.status) || t.errorCode !== null;
}

/** 从 RunState 的相邻快照差集生成本轮签名（不读模型输出）。 */
export function buildRoundSignature(
  state: Pick<RunStateData, 'tools' | 'fileChanges'>,
  toolOffset: number,
  fileOffset: number,
): RoundSignature {
  const newTools = state.tools.slice(Math.max(0, toolOffset));
  const filesDelta = Math.max(0, state.fileChanges.length - Math.max(0, fileOffset));
  // 摘要不含 callId：callId 每轮唯一，含它会导致 digest 每轮必变、"无变化"检测失效。
  // 只按工具的语义内容（name/status/summary/errorCode）判断本轮是否与上轮实质相同。
  const payload = newTools
    .map((t) => `${t.name}:${t.status}:${t.resultSummary ?? ''}:${t.errorCode ?? ''}`)
    .join('|');
  const allFailed = newTools.length > 0 && newTools.every(isFailedTool);
  const hasNoSignal = newTools.length === 0 && filesDelta === 0;
  return {
    filesDelta,
    resultDigest: digest(payload),
    allFailed,
    hasNoSignal,
  };
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export class ConvergenceDetector {
  private last: RoundSignature | null = null;
  private streakCount = 0;
  /** 内部有效阈值：threshold=1 视为「最小 2 轮」；threshold=0 保持关闭；threshold>=2 不变。 */
  private readonly effectiveThreshold: number;

  constructor(private readonly threshold: number) {
    this.effectiveThreshold = threshold <= 0 ? 0 : Math.max(2, threshold);
  }

  /**
   * 记录一轮签名。
   * - 首轮：无前值可比；本轮无改动记 1 轮，有改动记 0。
   * - 后续：文件改动 > 0 或结果 digest 变化 → 计数清零；否则 +1。
   * - 失败轮（allFailed=true）不累加收敛计数（streak 清零），避免失败循环被误判收敛。
   * - 无信号轮（hasNoSignal=true）不累加收敛计数（streak 清零），避免空转被误判收敛。
   * - threshold <= 0 时永不判收敛（关闭）。
   */
  record(signature: RoundSignature): ConvergenceVerdict {
    const previous = this.last;
    this.last = signature;

    let changed: boolean;
    if (!previous) {
      changed = signature.filesDelta > 0;
      this.streakCount = changed ? 0 : (signature.allFailed || signature.hasNoSignal ? 0 : 1);
    } else {
      // 任何一轮出现结果 digest 变化都算变化、计数清零（与文件头注释一致）。
      changed = signature.filesDelta > 0 || signature.resultDigest !== previous.resultDigest;
      if (signature.allFailed || signature.hasNoSignal) {
        // 失败轮、无信号轮不参与收敛计数，直接清零
        this.streakCount = 0;
      } else {
        this.streakCount = changed ? 0 : this.streakCount + 1;
      }
    }

    const converged = this.effectiveThreshold > 0 && this.streakCount >= this.effectiveThreshold;
    return { streak: this.streakCount, converged };
  }
}