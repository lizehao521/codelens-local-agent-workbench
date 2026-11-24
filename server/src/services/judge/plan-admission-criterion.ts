/**
 * 方向二第一刀：把"计划条目准入"包装成 judge 可复算的 L0 风格判据（纯函数无 IO）。
 *
 * 为什么新建独立模块而不是塞进 L0_CRITERIA：L0 判据塔被两处 toHaveLength(5)
 * 断言与 canary 固定夹具钉死，直接加第 6 条会打破既有判据的可打红性校验。
 * 本模块先证明"方向一判据可被 judge 独立复算"这条通路，接塔留作后续
 * （届时同步更新长度断言与 canary 夹具）。
 *
 * 复用而非重写：判定核心直接调用已落地的 evaluatePlanAdmission 纯函数，
 * 本文件只负责把它的 decision 映射成 CriterionVerdict（状态/理由/读数），
 * 不复制任何准入规则——判据口径单一事实来源仍是 plan-admission.ts。
 */
import {
  evaluatePlanAdmission,
  type AdmissionItem,
  type PlanAdmissionDecision,
} from '../plan/plan-admission.js';
import type { CriterionVerdict } from './types.js';

/** 判据输入：自包含证据，judge 只要能构造它就能复算，不需读数据库或时间。 */
export interface PlanAdmissionEvidence {
  items: readonly AdmissionItem[];
  activeItemId?: string | null;
  requestedItemId?: string | null;
  toolName?: string;
  operation?: string;
}

const CRITERION_ID = 'plan.admission';

/** 拒绝原因 → 人类可读理由（复算时写进 detail，供失败证据注入）。 */
const REASON_DETAIL: Record<PlanAdmissionDecision['reason'], string> = {
  admitted: '活跃条目与本次写请求的 planItemId 匹配',
  'no-active-item': '会话无活跃计划条目，写操作不应发生',
  'item-not-active': '写请求未声明 planItemId，无法归因到条目',
  'item-unknown': 'planItemId 与活跃条目不一致',
  'not-a-plan-write': '非写类操作，不适用计划准入',
};

/**
 * 计划准入判据：把 evaluatePlanAdmission 的 decision 映射成 CriterionVerdict。
 * - admitted        → pass
 * - 三种拒绝原因   → fail
 * - not-a-plan-write → unexec + weightExcluded（不适用，不计入 run.score 均值）
 */
export function planAdmissionCriterion(input: PlanAdmissionEvidence): CriterionVerdict {
  const decision = evaluatePlanAdmission({
    items: input.items,
    activeItemId: input.activeItemId,
    requestedItemId: input.requestedItemId,
    toolName: input.toolName,
    operation: input.operation,
  });

  if (decision.reason === 'not-a-plan-write') {
    return {
      layer: 'L0',
      criterion: CRITERION_ID,
      status: 'unexec',
      weightExcluded: true,
      detail: REASON_DETAIL[decision.reason],
      data: { reason: decision.reason },
    };
  }

  return {
    layer: 'L0',
    criterion: CRITERION_ID,
    status: decision.allowed ? 'pass' : 'fail',
    detail: REASON_DETAIL[decision.reason],
    data: { reason: decision.reason, allowed: decision.allowed },
  };
}
