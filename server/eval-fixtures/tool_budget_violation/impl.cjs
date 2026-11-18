function toolBudgetViolation(toolCalls, budget, countTypes) {
  if (!Array.isArray(toolCalls)) return { violated: false, count: 0, budget: budget };
  const types = Array.isArray(countTypes) && countTypes.length ? countTypes : null;
  const count = toolCalls.filter((c) => !types || (c && types.includes(c.type))).length;
  // 缺陷：用 >= 代替 >，刚好等于上限也被判违规（off-by-one）
  return { violated: count >= budget, count: count, budget: budget };
}
module.exports = { toolBudgetViolation: toolBudgetViolation };