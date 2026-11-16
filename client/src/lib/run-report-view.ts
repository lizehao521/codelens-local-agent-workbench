/** 历史汇报卡的展示层清洗：旧预算标签不再作为风险项展示。 */
const LEGACY_BUDGET_TRIGGERS = new Set(['成本超阈值', '预算耗尽', '预算自适应']);

export function visibleTriggers(triggers: readonly string[]): string[] {
  return triggers.filter((trigger) => !LEGACY_BUDGET_TRIGGERS.has(trigger));
}
