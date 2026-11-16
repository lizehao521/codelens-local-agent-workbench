/**
 * BudgetHit → Judge runtime 证据的窄投影。
 *
 * 单独成文件的原因：`agent-loop` 是历史大文件，围绕它的 diff 会混入既有的
 * 注释搬迁；判据层又是 P0 尺子。把「预算命中事实」抽成纯函数后，自动题只需
 * 改这个新模块，protected/judge 与老文件的历史注释都不再被触碰。
 */
import type { BudgetHit } from './loop-budget.js';

export interface BudgetKindEvidence {
  budgetKind: 'iterations' | 'tokens' | 'tool_calls' | 'wall_clock';
  budgetLimit: number;
  budgetUsed: number;
}

export function budgetKindEvidence(hit: BudgetHit): BudgetKindEvidence {
  return { budgetKind: hit.kind, budgetLimit: hit.limit, budgetUsed: hit.used };
}

// bridge RSI round: stable non-protected target for budget-kind evidence
