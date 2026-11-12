/**
 * iteration-gate-view — 迭代闸门的展示逻辑（纯函数）。
 *
 * 把 RsiIterationGate 面板里内联的筛选与三态映射抽到这里，
 * 不 import React、不碰 window、不读全局：参数进、值出，便于单测。
 */

export type FilterMode = 'all' | 'attention' | 'ok';
export type DecisionLike = string;
export type ItemLike = { id: string; task: string; decision: string };

const ATTENTION_DECISIONS = ['rollback', 'escalate', 'halt'];

/** 按筛选模式过滤迭代项。'all' 原样返回；空数组进来出空数组，不抛异常。 */
/** 泛型：允许调用方多带字段（例如把整条迭代记录挂上来），返回类型不退化。 */
export function filterIterations<T extends ItemLike>(items: T[], filter: FilterMode): T[] {
  if (filter === 'attention') {
    return items.filter((it) => ATTENTION_DECISIONS.includes(it.decision));
  }
  if (filter === 'ok') {
    return items.filter((it) => it.decision === 'continue');
  }
  return items;
}

/** 决策 → 语义色调。未知值返回 muted，不抛异常。 */
export function decisionTone(decision: DecisionLike): 'success' | 'danger' | 'warning' | 'muted' {
  switch (decision) {
    case 'continue':
      return 'success';
    case 'rollback':
    case 'halt':
      return 'danger';
    case 'retry':
    case 'escalate':
      return 'warning';
    default:
      return 'muted';
  }
}

/** 判据三态 → 中文标签。unexec 是「未执行」，绝不是「通过/成功」。 */
export function statusLabel(status: 'pass' | 'fail' | 'unexec'): string {
  switch (status) {
    case 'pass':
      return '通过';
    case 'fail':
      return '未通过';
    case 'unexec':
      return '未执行';
  }
}

/** 判据三态 → 语义类。unexec 不含 success；pass 与 fail 不同色，pass 不含 danger。 */
export function statusClass(status: 'pass' | 'fail' | 'unexec'): string {
  switch (status) {
    case 'pass':
      return 'text-success';
    case 'fail':
      return 'text-danger';
    case 'unexec':
      return 'text-text-tertiary';
  }
}