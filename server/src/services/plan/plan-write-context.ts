/**
 * 计划写上下文（方向一残留②接线）——把"会话活跃计划条目"派生成写闸准入上下文。
 *
 * 纯 IO 适配 + 确定性派生：只读 agent_plans，调用 selectActiveItem 选出活跃条目，
 * 组装成 gateWriteCall / evaluatePlanAdmission 需要的 AdmissionItem[] + activeItemId。
 *
 * 关键向后兼容：会话没有任何 approved/running 条目时返回 undefined —— 调用方据此
 * 跳过计划准入（写闸回落到 occupancy/finishReason 口径），老会话/无计划会话写入不受影响。
 * 只有当会话确实认领了活跃条目，才强制本次写请求声明匹配的 planItemId。
 *
 * 为什么独立成模块：agent-loop.service.ts / runtime.ts 都在行数棘轮上且只剩 1 行余量，
 * 派生逻辑不能塞进它们；executor 只持有这个薄适配器的引用即可。
 */
import type { Db } from '../../repositories/db.js';
import { PlanRepository } from '../../repositories/plan.repository.js';
import { PlanService, selectActiveItem } from './plan.service.js';
import type { AdmissionItem } from './plan-admission.js';

export interface PlanWriteContext {
  items: readonly AdmissionItem[];
  activeItemId: string;
}

/**
 * 按 sessionId 从 agent_plans 派生写闸准入上下文。
 * 无活跃条目 → undefined（调用方跳过计划准入，保持历史行为）。
 */
export function buildPlanWriteContext(db: Db | undefined, sessionId: string): PlanWriteContext | undefined {
  if (!db) return undefined;
  const service = new PlanService(new PlanRepository(db));
  const items = service.listBySession(sessionId, 50);
  const active = selectActiveItem(items);
  if (!active) return undefined;
  return {
    items: items.map((it) => ({ id: it.id, status: it.status })),
    activeItemId: active.id,
  };
}
