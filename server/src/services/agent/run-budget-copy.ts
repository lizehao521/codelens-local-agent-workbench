/** 预算触顶时的未完成项文案（纯函数，便于单测/复用）。 */
import type { RunBudgetRecord } from '../../types/run-state.js';

export function budgetUnfinished(budget: RunBudgetRecord): string[] {
  switch (budget.kind) {
    case 'iterations':
      return ['模型未继续生成后续步骤'];
    case 'tool_calls':
      return ['后续计划的工具调用未执行'];
    case 'tokens':
      return ['后续轮次因 token 上限未执行'];
    case 'wall_clock':
      return ['后续轮次因墙钟上限未执行'];
  }
}
