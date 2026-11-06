// 工具时间线分组 —— 同名连续 ≥3 次合并为组；异工具不合并；跨轮绝不合并
// 输入：单条 assistant 消息内按序的 tool 卡；输出：渲染块序列。

import type { ToolCallVM } from '../types';

export type ToolBlock =
  | { kind: 'single'; call: ToolCallVM }
  | { kind: 'group'; toolName: string; calls: ToolCallVM[] };

/** 连续同名合并的最小长度 */
export const GROUP_MIN_RUN = 3;

/** 单轮折叠阈值：本轮调用总数 > 8 → 整轮折叠为汇总行 */
export const ROUND_COLLAPSE_THRESHOLD = 8;

/**
 * 规则 1–5：只在单条消息内跑（天然不跨轮）；中间插入任何不同名调用即断流。
 */
export function buildToolBlocks(calls: ToolCallVM[]): ToolBlock[] {
  const blocks: ToolBlock[] = [];
  let i = 0;
  while (i < calls.length) {
    let j = i;
    while (j + 1 < calls.length && calls[j + 1].name === calls[i].name) j += 1;
    const run = calls.slice(i, j + 1);
    if (run.length >= GROUP_MIN_RUN) {
      blocks.push({ kind: 'group', toolName: run[0].name, calls: run });
    } else {
      for (const call of run) blocks.push({ kind: 'single', call });
    }
    i = j + 1;
  }
  return blocks;
}

/**
 * 「未成功数」唯一口径：failed + timeout。
 * rejected / skipped 是人为决策，明确不计入 —— 误计会让「我拒绝了 3 次」
 * 看起来像「Agent 错了 3 次」，是错误归因。
 */
export function countFailures(calls: ToolCallVM[]): number {
  return calls.filter((c) => c.status === 'failed' || c.status === 'timeout').length;
}

/** 组头状态图标取最严重者：failed > timeout > rejected > skipped > success */
export function groupSeverity(calls: ToolCallVM[]): ToolCallVM['status'] {
  const order: ToolCallVM['status'][] = ['failed', 'timeout', 'rejected', 'skipped', 'running', 'pending', 'success'];
  for (const status of order) {
    if (calls.some((c) => c.status === status)) return status;
  }
  return 'success';
}

/** 组内总耗时（最早开始 → 最晚结束），无时间戳时回落各卡 durationMs 之和 */
export function groupDurationMs(calls: ToolCallVM[]): number | undefined {
  const starts = calls.map((c) => c.startedAt).filter((n): n is number => typeof n === 'number');
  const ends = calls.map((c) => c.endedAt).filter((n): n is number => typeof n === 'number');
  if (starts.length > 0 && ends.length > 0) {
    return Math.max(...ends) - Math.min(...starts);
  }
  const sum = calls.reduce((acc, c) => acc + (c.durationMs ?? 0), 0);
  return sum > 0 ? sum : undefined;
}

/** 单轮是否折叠为汇总行 */
export function shouldCollapseRound(count: number): boolean {
  return count > ROUND_COLLAPSE_THRESHOLD;
}

/** 汇总行文案（RoundSummaryRow 共用，避免业务规则进 JSX） */
export function buildRoundSummary(calls: ToolCallVM[]): {
  total: number;
  failures: number;
  durationMs: number | undefined;
} {
  return {
    total: calls.length,
    failures: countFailures(calls),
    durationMs: groupDurationMs(calls),
  };
}

/** 块与块之间是否需要插入「间隔 x.xs」行 */
export function gapBetween(prev: ToolBlock, next: ToolBlock): { startedAt: number; endedAt: number } | null {
  const prevEnd = lastEndedAt(prev);
  const nextStart = firstStartedAt(next);
  if (prevEnd === undefined || nextStart === undefined) return null;
  return { startedAt: nextStart, endedAt: prevEnd };
}

function lastEndedAt(block: ToolBlock): number | undefined {
  const calls = block.kind === 'single' ? [block.call] : block.calls;
  const ends = calls.map((c) => c.endedAt).filter((n): n is number => typeof n === 'number');
  return ends.length > 0 ? Math.max(...ends) : undefined;
}

function firstStartedAt(block: ToolBlock): number | undefined {
  const calls = block.kind === 'single' ? [block.call] : block.calls;
  const starts = calls.map((c) => c.startedAt).filter((n): n is number => typeof n === 'number');
  return starts.length > 0 ? Math.min(...starts) : undefined;
}
