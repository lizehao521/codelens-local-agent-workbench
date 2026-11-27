/**
 * π 版本 diff —— 回答「这次改版到底改了什么」。
 *
 * lessons 是无 ID 的字符串数组（经验即文本），所以 diff 只能分三类：
 *   · added    —— 新版多出来的经验；
 *   · removed  —— 新版删掉的经验；
 *   · thresholds —— 键级变化（from → to），阈值面是有键的，能做真正的键 diff。
 *
 * 不做「相似度合并」：把「近似的两句」判成 changed 需要语义判断，
 * 而 UI 要展示的是**事实**（这版加了什么、删了什么），不是模型意见。
 * 纯函数，无 IO —— 单测直接钉边界。
 */

import type { Policy } from '../../repositories/policy.repository.js';

export interface ThresholdChange {
  key: string;
  from: number | null;
  to: number | null;
}

export interface PolicyDiff {
  added: string[];
  removed: string[];
  thresholdChanges: ThresholdChange[];
}

/** 相邻两版（prev 可为 null = 首版，全部算 added）。 */
export function diffPolicyVersions(prev: Policy | null, next: Policy): PolicyDiff {
  const prevLessons = new Set(prev?.lessons ?? []);
  const nextLessons = new Set(next.lessons ?? []);

  const added = [...nextLessons].filter((l) => !prevLessons.has(l));
  const removed = [...prevLessons].filter((l) => !nextLessons.has(l));

  const prevThresholds = prev?.thresholds ?? {};
  const nextThresholds = next.thresholds ?? {};
  const keys = new Set([...Object.keys(prevThresholds), ...Object.keys(nextThresholds)]);
  const thresholdChanges: ThresholdChange[] = [];
  for (const key of [...keys].sort()) {
    const from = typeof prevThresholds[key] === 'number' ? prevThresholds[key]! : null;
    const to = typeof nextThresholds[key] === 'number' ? nextThresholds[key]! : null;
    if (from !== to) thresholdChanges.push({ key, from, to });
  }

  return { added, removed, thresholdChanges };
}