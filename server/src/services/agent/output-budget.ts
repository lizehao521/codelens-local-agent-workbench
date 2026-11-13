/**
 * 自适应输出预算。
 *
 * 推理型模型（reasoning_content）会把 max_tokens 先花在思考上：
 * 预算小的时候，上游以 finish_reason=length 结束，正文与工具调用都是空的，
 * 看起来像「上游返回空响应」，实际是预算不够。
 *
 * 规则（只做一次）：
 *   - 不低于 2048：低于这个值时推理型模型几乎没有机会产出工具调用；
 *   - 翻倍：尊重调用方原本的预算意图；
 *   - 不超过 4096：单轮重试的成本上限，避免自动放大成一次大额调用。
 */
export const OUTPUT_BUDGET_MIN = 2048;
export const OUTPUT_BUDGET_CAP = 4096;

export function adaptOutputBudget(current: number): number {
  if (!Number.isFinite(current) || current <= 0) return OUTPUT_BUDGET_MIN;
  return Math.min(Math.max(current * 2, OUTPUT_BUDGET_MIN), OUTPUT_BUDGET_CAP);
}
