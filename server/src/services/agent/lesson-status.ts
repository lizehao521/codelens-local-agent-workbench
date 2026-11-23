/**
 * 经验状态优先淘汰 —— 从 Update.evict 抽出的纯函数（保持 update.service.ts 在行数棘轮内）。
 *
 * 被标记 superseded / contradicted 的经验代表「已被取代 / 已被反驳」的显式声明，
 * 比任何统计排序都更可信：超限淘汰时先于 passRate 排序与 FIFO 丢掉它们。
 * 缺省（未记录状态）视为 active，行为与旧逻辑一致。
 */
import type { LessonStatus } from '../../repositories/policy.repository.js';

export type { LessonStatus };

/**
 * 优先淘汰被标记 superseded/contradicted 的经验。
 * @returns 淘汰 marked 后的 lessons 与仍需淘汰的数量（剩余部分交给调用方走 passRate/FIFO）。
 *          纯函数、无副作用、不依赖 repo —— 便于单测与保持 evict 主体简洁。
 */
export function evictMarkedLessons(
  lessons: string[],
  overflow: number,
  status?: Record<string, LessonStatus>,
): { lessons: string[]; overflow: number } {
  if (overflow <= 0 || !status) return { lessons, overflow };
  const marked = lessons.filter((l) => status[l] === 'superseded' || status[l] === 'contradicted');
  if (marked.length === 0) return { lessons, overflow };
  const dropCount = Math.min(overflow, marked.length);
  const drop = new Set(marked.slice(0, dropCount));
  return { lessons: lessons.filter((l) => !drop.has(l)), overflow: overflow - dropCount };
}
