/**
 * Plan service — 可编辑计划面板（agent_plans）的业务面。
 *
 * 职责（仓储只放 SQL，本服务承担其余一切）：
 *  - steps_json 编解码：入库前 JSON.stringify，读出时 parse + 兜底；
 *  - 行 → 视图（snake_case → camelCase，steps 解码为对象数组）；
 *  - 状态流转校验（非法流转抛 PlanInvalidTransitionError，由 controller 映射 409）。
 *
 * 不做权限判断：会话归属校验（AUDIT-018 assertOwned）在 controller。
 */

import { PlanRepository, type PlanRow, type PlanStatus } from '../../repositories/plan.repository.js';
import { newUuid } from '../../utils/hash.js';

/** 一个计划步骤（客户端提交形态，status 由服务端维护）。 */
export interface PlanStep {
  title: string;
  detail?: string;
}

export interface PlanStepInput {
  title: string;
  detail?: string;
}

/** 对外视图（camelCase）。 */
export interface PlanView {
  id: string;
  sessionId: string;
  runId: string | null;
  title: string;
  status: PlanStatus;
  steps: PlanStep[];
  createdAt: number;
  updatedAt: number;
}

export interface CreatePlanInput {
  title?: string;
  steps: PlanStepInput[];
}

export type ReplacePlanInput = CreatePlanInput;

/** 非法状态流转（controller 映射为 409 PLAN_INVALID_TRANSITION）。 */
export class PlanInvalidTransitionError extends Error {
  constructor(from: PlanStatus, to: PlanStatus) {
    super(`计划状态不允许从 ${from} 流转到 ${to}`);
    this.name = 'PlanInvalidTransitionError';
  }
}

/** 合法流转表：draft→approved→running→done；任何非终态可 cancelled；approved 可退回 draft 重编辑。 */
const TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  draft: ['approved', 'cancelled'],
  approved: ['running', 'draft', 'cancelled'],
  running: ['done', 'cancelled'],
  done: [],
  cancelled: [],
};

export class PlanService {
  constructor(private readonly plans: PlanRepository) {}

  /** steps_json 解码；损坏/非数组时兜底为空数组（历史脏数据不应让面板白屏）。 */
  private decodeSteps(stepsJson: string): PlanStep[] {
    try {
      const parsed: unknown = JSON.parse(stepsJson);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((s): s is PlanStep => typeof s === 'object' && s !== null && typeof (s as PlanStep).title === 'string')
        .map((s) => (s.detail !== undefined ? { title: s.title, detail: String(s.detail) } : { title: s.title }));
    } catch {
      return [];
    }
  }

  private encodeSteps(steps: PlanStepInput[]): string {
    return JSON.stringify(steps.map((s) => (s.detail !== undefined ? { title: s.title, detail: s.detail } : { title: s.title })));
  }

  toView(row: PlanRow): PlanView {
    return {
      id: row.id,
      sessionId: row.session_id,
      runId: row.run_id,
      title: row.title,
      status: row.status,
      steps: this.decodeSteps(row.steps_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listBySession(sessionId: string, limit: number): PlanView[] {
    return this.plans.listBySession(sessionId, limit).map((row) => this.toView(row));
  }

  get(id: string): PlanView | undefined {
    const row = this.plans.get(id);
    return row ? this.toView(row) : undefined;
  }

  /** 新建计划，初始状态恒为 draft（客户端不可指定 status）。 */
  create(sessionId: string, input: CreatePlanInput, runId?: string | null): PlanView {
    const now = Date.now();
    const row = this.plans.insert({
      id: newUuid(),
      sessionId,
      runId: runId ?? null,
      title: input.title ?? '',
      status: 'draft',
      stepsJson: this.encodeSteps(input.steps),
      createdAt: now,
      updatedAt: now,
    });
    return this.toView(row);
  }

  /** 整体替换步骤与标题（幂等）；计划不存在时返回 undefined。 */
  replace(id: string, input: ReplacePlanInput): PlanView | undefined {
    const updated = this.plans.updateSteps(id, input.title ?? '', this.encodeSteps(input.steps), Date.now());
    if (updated === 0) return undefined;
    return this.get(id);
  }

  /** 状态流转；计划不存在返回 undefined，非法流转抛 PlanInvalidTransitionError。 */
  transition(id: string, to: PlanStatus): PlanView | undefined {
    const row = this.plans.get(id);
    if (!row) return undefined;
    if (!TRANSITIONS[row.status].includes(to)) {
      throw new PlanInvalidTransitionError(row.status, to);
    }
    this.plans.updateStatus(id, to, Date.now());
    return this.get(id);
  }

  /**
   * 当前活跃条目（只读派生）：从会话计划里确定性挑一条 approved/running。
   * 判定的纯逻辑在 selectActiveItem，本方法只做仓储读取 + 调用，不引入业务分支。
   */
  activeItem(sessionId: string, limit = 50): PlanView | null {
    return selectActiveItem(this.listBySession(sessionId, limit));
  }
}

/**
 * 从计划列表里确定性选出"当前活跃条目"（方向一第二刀，纯函数无 IO）。
 *
 * 规则：
 *  1. 只考虑 approved / running 状态；draft/done/cancelled 一律排除；
 *  2. 多条候选时按确定性 tie-break 选唯一一条：updatedAt 大者优先，
 *     相同则 createdAt 大者优先，仍相同则 id 字典序小者优先（全序、无随机、无时间依赖）；
 *  3. 无任何候选返回 null。
 *
 * 为什么纯函数：验收对象是"列表 → 选中项或 null"的映射，表驱动单测 + 变异体
 * 可直接复算；仓储只提供列表，不在本函数内读时间/随机/外部状态。
 */
export function selectActiveItem(items: readonly PlanView[]): PlanView | null {
  const candidates = items.filter((it) => it.status === 'approved' || it.status === 'running');
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted[0] ?? null;
}
