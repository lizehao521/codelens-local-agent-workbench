/**
 * L0 机械判据（强化内核宣言第 3 节）。
 *
 * 这一层只回答「格式/字段/阈值是否成立」，不判语义、不判对抗 —— 那是 L2/L3 的事。
 * 每条判据都是纯函数：同样的证据必然得到同样的判决，因此可被单测与破坏夹具钉死。
 *
 * 阈值来自 π 的 thresholds 面（此前是死字段，没有真实消费者）。为遵守
 * 「不得改判据的度量口径来迁就结果」，所有可调阈值都被 clamp 在安全区间内：
 * 自我修改可以把闸拧紧，但不允许把它拧松到失效。
 */

import type { CriterionVerdict, JudgeEvidence } from './types.js';

export interface L0Thresholds {
  /** 工具调用成功率下限。 */
  minToolSuccessRate: number;
  /** 审批拒绝率上限。 */
  maxApprovalRejectionRate: number;
  /** token 预算使用率上限。 */
  maxBudgetUsageRate: number;
}

export const DEFAULT_L0_THRESHOLDS: L0Thresholds = {
  minToolSuccessRate: 0.6,
  maxApprovalRejectionRate: 0.5,
  maxBudgetUsageRate: 0.9,
};

/**
 * 阈值安全区间：无论 π 怎么写，都不能越过这里。
 * 这是「判据不可被结果反向篡改」的机器化表达 —— 自我修改只能收紧。
 */
const THRESHOLD_BOUNDS: Record<keyof L0Thresholds, { min: number; max: number }> = {
  // 成功率下限最高只允许提到 1.0；不得低于 0.2，否则「几乎不做成事」也算通过。
  minToolSuccessRate: { min: 0.2, max: 1 },
  // 拒绝率上限最低允许收到 0；不得高于 0.8，否则「大半被拒」也算健康。
  maxApprovalRejectionRate: { min: 0, max: 0.8 },
  maxBudgetUsageRate: { min: 0.3, max: 1 },
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 把外部（可能被自我修改过的）阈值收敛进安全区间。 */
export function resolveThresholds(raw?: Record<string, number> | null): L0Thresholds {
  const pick = (key: keyof L0Thresholds): number => {
    const candidate = raw?.[key];
    const bounds = THRESHOLD_BOUNDS[key];
    const fallback = DEFAULT_L0_THRESHOLDS[key];
    // 非法或缺失的值一律回落到「默认值」，而不是区间下界。
    // 下界是留给「合法但极端」的自我修改的；拿它兜脏数据会把判据
    // 意外拧到最严（例如预算上限被压到 30%），制造假红。
    const value = typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : fallback;
    return clamp(value, bounds.min, bounds.max);
  };
  return {
    minToolSuccessRate: pick('minToolSuccessRate'),
    maxApprovalRejectionRate: pick('maxApprovalRejectionRate'),
    maxBudgetUsageRate: pick('maxBudgetUsageRate'),
  };
}

export type L0Criterion = (evidence: JudgeEvidence, thresholds: L0Thresholds) => CriterionVerdict;

/** 工具调用达到终态的集合：只有这些才配进入成功率的分母。 */
const TERMINAL_STATUSES = new Set(['success', 'failed', 'timeout', 'rejected']);

/**
 * 工具成功率。分母只算终态调用 —— pending/running 是「还没发生」，
 * 把它们计入分母会把「刚起手」误判为失败。
 *
 * 口径（sys.exec 加入后修正）：**「工具状态 success」≠「做成了事」**。
 * 命令执行的 success 只表示「命令跑完了」，`npm test` 返回 1、`git diff --exit-code`
 * 返回 1、`tsc --noEmit` 报错同样是 success 状态。若按 status 统计，「命令能跑」
 * 会被记成「代码正确」，判据塔就会凭这个数字给出错误结论 —— 所以凡是带真实
 * exitCode 的调用一律看 `exitCode === 0`；没有 exitCode 的调用（其余内置工具）
 * 沿用 status。这条不看工具状态，看的是工具**报出来的执行结果**。
 */
export const toolSuccessRate: L0Criterion = (evidence, thresholds) => {
  const terminal = evidence.toolCalls.filter((c) => TERMINAL_STATUSES.has(c.status));
  if (terminal.length === 0) {
    return {
      layer: 'L0',
      criterion: 'tool.success_rate',
      status: 'unexec',
      detail: '本轮无终态工具调用，成功率不可计算',
    };
  }
  const exitedNonZero = (c: { exit_code?: number | null }): boolean =>
    typeof c.exit_code === 'number' && c.exit_code !== 0;
  const success = terminal.filter(
    (c) => c.status === 'success' && !exitedNonZero(c),
  ).length;
  const rate = success / terminal.length;
  const pass = rate >= thresholds.minToolSuccessRate;
  const nonZero = terminal.filter((c) => c.status === 'success' && exitedNonZero(c)).length;
  const exitNote = nonZero > 0 ? `，其中 ${nonZero} 次命令执行退出码非 0（不计入成功）` : '';
  return {
    layer: 'L0',
    criterion: 'tool.success_rate',
    status: pass ? 'pass' : 'fail',
    score: round3(rate),
    detail: `终态调用 ${terminal.length} 次，成功 ${success} 次（${(rate * 100).toFixed(1)}%）${exitNote}，下限 ${(thresholds.minToolSuccessRate * 100).toFixed(0)}%`,
  };
};

/**
 * 终止性：任务是否以「正常结束」收尾。
 * 四类非正常终止各自对应一种真实故障，都必须判 fail 而不是含糊放过。
 */
export const taskTerminal: L0Criterion = (evidence) => {
  switch (evidence.finishReason) {
    case 'stop':
      return {
        layer: 'L0',
        criterion: 'task.terminal',
        status: 'pass',
        detail: '模型正常结束输出',
      };
    case 'max_iterations':
      return {
        layer: 'L0',
        criterion: 'task.terminal',
        status: 'fail',
        detail: `迭代上限耗尽（${evidence.iteration} 轮）仍未收敛`,
      };
    case 'budget_exhausted':
      return {
        layer: 'L0',
        criterion: 'task.terminal',
        status: 'fail',
        detail: 'token 预算耗尽而任务未完成',
      };
    case 'aborted':
      return {
        layer: 'L0',
        criterion: 'task.terminal',
        status: 'fail',
        detail: '任务被中止',
      };
    case 'circuit_open':
      return {
        layer: 'L0',
        criterion: 'task.terminal',
        status: 'fail',
        detail: '熔断打开，任务未能继续',
      };
    default:
      return {
        layer: 'L0',
        criterion: 'task.terminal',
        status: 'unexec',
        detail: `未知终止原因「${evidence.finishReason}」，无对应判据`,
      };
  }
};

/** 循环健康：本轮是否触发过熔断。触发即说明重复失败已到危险水位。 */
export const loopHealth: L0Criterion = (evidence) => {
  if (evidence.circuitOpened) {
    return {
      layer: 'L0',
      criterion: 'loop.health',
      status: 'fail',
      detail: '本轮触发过熔断，存在重复失败',
    };
  }
  return {
    layer: 'L0',
    criterion: 'loop.health',
    status: 'pass',
    detail: '未触发熔断',
  };
};

/**
 * 审批摩擦：被拒比例过高说明「模型想做的事」与「用户允许的事」错位。
 * 没有发生任何审批时为 unexec —— 没摩擦不等于没风险，只是没测到。
 */
export const approvalFriction: L0Criterion = (evidence, thresholds) => {
  const decided = evidence.approvals.filter((a) => a.decision !== null || a.status === 'expired');
  if (decided.length === 0) {
    return {
      layer: 'L0',
      criterion: 'approval.friction',
      status: 'unexec',
      detail: '本轮未发生审批，摩擦率不可计算',
    };
  }
  const rejected = decided.filter((a) => a.decision === 'reject').length;
  const rate = rejected / decided.length;
  const pass = rate <= thresholds.maxApprovalRejectionRate;
  return {
    layer: 'L0',
    criterion: 'approval.friction',
    status: pass ? 'pass' : 'fail',
    score: round3(rate),
    detail: `审批 ${decided.length} 次、被拒 ${rejected} 次（${(rate * 100).toFixed(1)}%），上限 ${(thresholds.maxApprovalRejectionRate * 100).toFixed(0)}%`,
  };
};

/**
 * 预算效率：花了多少比例的钱。超支通常意味着反复试错或上下文膨胀。
 * 无预算（<=0）时 unexec，而不是假装通过。
 */
export const budgetEfficiency: L0Criterion = (evidence, thresholds) => {
  if (!Number.isFinite(evidence.tokenBudget) || evidence.tokenBudget <= 0) {
    return {
      layer: 'L0',
      criterion: 'budget.efficiency',
      status: 'unexec',
      detail: '本轮无 token 预算，使用率不可计算',
    };
  }
  const used = evidence.usage.promptTokens + evidence.usage.completionTokens;
  const rate = used / evidence.tokenBudget;
  const pass = rate <= thresholds.maxBudgetUsageRate;
  return {
    layer: 'L0',
    criterion: 'budget.efficiency',
    status: pass ? 'pass' : 'fail',
    score: round3(Math.min(rate, 1)),
    detail: `用量 ${used}/${evidence.tokenBudget}（${(rate * 100).toFixed(1)}%），上限 ${(thresholds.maxBudgetUsageRate * 100).toFixed(0)}%`,
  };
};

export const L0_CRITERIA: L0Criterion[] = [
  toolSuccessRate,
  taskTerminal,
  loopHealth,
  approvalFriction,
  budgetEfficiency,
];

/** 统一保留三位小数，避免浮点噪声污染判决比对与聚合。 */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
