/**
 * 计划条目准入（方向一第一刀）——纯函数，无 IO。
 *
 * 写盘前的准入判定：会话必须存在活跃计划条目，且本次写请求的
 * planItemId 必须指向该活跃条目，才放行写类操作；非写类操作一律放行。
 *
 * 为什么是纯函数：验收对象是输入到决策的映射，机械判据（表驱动/变异体）
 * 能直接断言，不依赖时间、随机或外部可变状态。接线方（plan.service /
 * write-guard）只做状态存取与调用，不在此文件引入业务分支。
 *
 * 判据形态沿用内核三态决策：reason 是枚举而非布尔，拒绝原因可观测，
 * 便于失败证据注入（告诉模型"先建/认领一个条目"）。
 */

/** 一个计划条目的最小准入视图（与 plan.service 的 PlanView 解耦）。 */
export interface AdmissionItem {
  id: string;
  /** 仅 approved/running 等"已认领"状态可参与准入；draft 不算活跃。 */
  status: string;
}

export interface PlanAdmissionInput {
  /** 会话当前全部计划条目。 */
  items: readonly AdmissionItem[];
  /** 被认领为"当前活跃"的条目 id（来自会话状态，非请求方自报）。 */
  activeItemId?: string | null;
  /** 本次写请求声明要执行的条目 id。 */
  requestedItemId?: string | null;
  /** 工具 wireName。非 fs_write 一律放行。 */
  toolName?: string;
  /** fs_write 的 operation。非写操作一律放行。 */
  operation?: string;
}

export type AdmissionReason =
  | 'admitted'
  | 'no-active-item'
  | 'item-not-active'
  | 'item-unknown'
  | 'not-a-plan-write';

export interface PlanAdmissionDecision {
  allowed: boolean;
  reason: AdmissionReason;
}

const WRITE_OPERATIONS = new Set(['create', 'overwrite', 'append', 'replace', 'purge', 'delete', 'rename']);

function isPlanWrite(input: PlanAdmissionInput): boolean {
  const tool = input.toolName ?? 'fs_write';
  if (tool !== 'fs_write' && tool !== 'fs.write') return false;
  return WRITE_OPERATIONS.has(input.operation ?? '');
}

/**
 * 判定一次写请求是否通过计划条目准入。
 *
 * 顺序（短路，先判非写类，再判活跃条目，再判请求匹配）：
 *  1. 非写类工具/操作 → not-a-plan-write（放行，不受准入影响）；
 *  2. 无活跃条目（activeItemId 空，或指向的条目不存在）→ no-active-item（拒绝）；
 *  3. 请求未声明 planItemId → item-not-active（拒绝，不能靠缺省绕过）；
 *  4. 请求的 id 不等于活跃 id → item-unknown（拒绝）；
 *  5. 匹配 → admitted（放行）。
 */
export function evaluatePlanAdmission(input: PlanAdmissionInput): PlanAdmissionDecision {
  if (!isPlanWrite(input)) return { allowed: true, reason: 'not-a-plan-write' };

  const activeId = input.activeItemId;
  if (!activeId) return { allowed: false, reason: 'no-active-item' };

  const activeItem = input.items.find((it) => it.id === activeId);
  if (!activeItem) return { allowed: false, reason: 'no-active-item' };

  const requested = input.requestedItemId;
  if (!requested) return { allowed: false, reason: 'item-not-active' };
  if (requested !== activeId) return { allowed: false, reason: 'item-unknown' };

  return { allowed: true, reason: 'admitted' };
}
