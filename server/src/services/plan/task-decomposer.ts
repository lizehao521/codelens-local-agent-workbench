/**
 * 长任务分解内核 — 纯函数、确定性、无模型调用。
 *
 * 模型/人类只提供一次交付物列表（GoalSpec），本模块做确定性展开：
 * 把交付物列表展开成可执行单元 DAG，把模型踢出循环。每个单元自足
 * （客观签名 + 目标文件 + 验收判据 + 禁读码铁律），外层调度器用
 * unitToPrompt 序列化后逐个回丢给 CodeLens 执行（单文件 + 首动作 fs.write）。
 */

export type UnitStatus = 'pending' | 'ready' | 'running' | 'done' | 'failed' | 'skipped';
export type AcceptanceKind = 'tsc' | 'vitest' | 'ratchet' | 'diff-check' | 'signature' | 'file-exists';

export interface AcceptanceCheck {
  id: string;
  kind: AcceptanceKind;
  scope?: string;
  expect?: string;
  maxLines?: number;
  contains?: string;
}

export interface TaskUnit {
  id: string;
  title: string;
  goal: string;
  deps: string[];
  writeScope: string[];
  readScope: string[];
  contract?: { file: string; exportName: string; signature: string };
  acceptance: AcceptanceCheck[];
  budget: { toolCalls: number; maxLines: number };
  execution: { firstToolCall: 'fs.write'; readPolicy: 'forbid' };
  status: UnitStatus;
  attempts: number;
  lastError?: string;
}

export interface Deliverable {
  key: string;
  path: string;
  kind: 'impl' | 'test';
  exportName?: string;
  signature?: string;
  dependsOn?: string[];
  maxLines?: number;
}

export interface GoalSpec {
  id: string;
  title: string;
  deliverables: Deliverable[];
}

export interface RepoFacts {
  tsconfigInclude: string[];
  defaultMaxToolCalls: number;
  newFileMaxLines: number;
  frozenFiles: Record<string, number>;
}

export class DecomposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecomposeError';
  }
}

/** path 是否落在 tsconfigInclude 的某个目录下（前缀匹配，按段）。 */
function inInclude(path: string, include: string[]): boolean {
  return include.some((p) => {
    const dir = p.endsWith('/') ? p : p + '/';
    return path.startsWith(dir) || path === p;
  });
}

/** Kahn 拓扑排序，返回按依赖优先（被依赖者在前）的稳定序列；有环抛错。 */
function topoOrder(nodes: string[], depsOf: (k: string) => string[]): string[] {
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const k of nodes) {
    indeg.set(k, 0);
    out.set(k, []);
  }
  for (const k of nodes) {
    for (const dep of depsOf(k)) {
      if (!indeg.has(dep)) continue;
      indeg.set(k, (indeg.get(k) ?? 0) + 1);
      out.get(dep)!.push(k);
    }
  }
  // 初始入度为 0 的节点按给定顺序入队，保证确定性。
  const queue = nodes.filter((k) => indeg.get(k) === 0);
  const order: string[] = [];
  while (queue.length) {
    const k = queue.shift()!;
    order.push(k);
    for (const next of out.get(k) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) throw new DecomposeError('cycle detected');
  return order;
}

/**
 * 把交付物列表确定性展开成可执行单元 DAG。
 * 纯函数：无 Date.now / Math.random / 模型调用，同输入恒等输出。
 */
export function decompose(goal: GoalSpec, facts: RepoFacts): TaskUnit[] {
  // 1) 校验：key 唯一且非空、path 非空、dependsOn 引用的 key 必须存在。
  const byKey = new Map<string, Deliverable>();
  for (const d of goal.deliverables) {
    if (!d.key) throw new DecomposeError('empty key');
    if (byKey.has(d.key)) throw new DecomposeError(`duplicate key: ${d.key}`);
    if (!d.path) throw new DecomposeError(`empty path for key: ${d.key}`);
    byKey.set(d.key, d);
  }
  for (const d of goal.deliverables) {
    for (const dep of d.dependsOn ?? []) {
      if (!byKey.has(dep)) throw new DecomposeError(`unknown dep key: ${dep}`);
    }
  }

  // 2) 稳定排序：先 kind（impl=0, test=1）再 path 字典序，得到确定的节点顺序。
  const sorted = [...goal.deliverables].sort((a, b) => {
    const ka = a.kind === 'impl' ? 0 : 1;
    const kb = b.kind === 'impl' ? 0 : 1;
    if (ka !== kb) return ka - kb;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  // 3) 拓扑序分配 id：被依赖者编号更小，外层按 id 回丢时不会卡在依赖未就绪。
  //    同时完成无环断言（topoOrder 内部抛 DecomposeError）。
  const order = topoOrder(sorted.map((d) => d.key), (k) => byKey.get(k)!.dependsOn ?? []);
  const idOf = new Map<string, string>();
  order.forEach((k, i) => idOf.set(k, `u${String(i + 1).padStart(2, '0')}`));

  // 3) 逐交付物产单元。
  const units: TaskUnit[] = sorted.map((d) => {
    const id = idOf.get(d.key)!;
    const deps = (d.dependsOn ?? []).map((k) => idOf.get(k)!);
    const maxLines = d.maxLines ?? facts.newFileMaxLines;

    const acceptance: AcceptanceCheck[] = [
      { id: 'diff', kind: 'diff-check' },
      { id: 'ratchet', kind: 'ratchet', scope: d.path, maxLines },
    ];
    if (d.kind === 'test') {
      acceptance.push({ id: 'vitest', kind: 'vitest', scope: d.path, expect: 'passed' });
    } else if (inInclude(d.path, facts.tsconfigInclude)) {
      acceptance.push({ id: 'tsc', kind: 'tsc', expect: 'exit 0' });
    }
    if (d.signature) {
      acceptance.push({ id: 'sig', kind: 'signature', scope: d.path, contains: d.signature });
    }

    return {
      id,
      title: `${d.kind === 'impl' ? '实现' : '测试'} ${d.key}`,
      goal: `${goal.title} → ${d.path}`,
      deps,
      writeScope: [d.path],
      readScope: [],
      ...(d.exportName && d.signature
        ? { contract: { file: d.path, exportName: d.exportName, signature: d.signature } }
        : {}),
      acceptance,
      budget: { toolCalls: 1, maxLines },
      execution: { firstToolCall: 'fs.write', readPolicy: 'forbid' },
      status: 'pending',
      attempts: 0,
    };
  });

  // 4) 按 id（拓扑序）排序返回，保证数组顺序即回丢顺序，依赖恒先于被依赖者。
  return [...units].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 把单元序列化成可直接回丢给 CodeLens 的短任务提示（纯字符串、确定性）。 */
export function unitToPrompt(unit: TaskUnit): string {
  const lines: string[] = [
    `【短任务 ${unit.id}】${unit.title}`,
    '',
    `目标：${unit.goal}`,
    `唯一写点：${unit.writeScope[0]}`,
    '',
    '铁律：第一个工具调用必须是 fs.write；禁止读码；写完立即收尾。',
  ];
  if (unit.contract) {
    lines.push('', '客观签名（直接用，勿读码）：', unit.contract.signature);
  }
  lines.push('', '验收判据：');
  for (const a of unit.acceptance) {
    const parts: string[] = [a.kind];
    if (a.scope) parts.push(a.scope);
    if (a.expect) parts.push(`expect=${a.expect}`);
    if (a.maxLines !== undefined) parts.push(`maxLines=${a.maxLines}`);
    if (a.contains) parts.push(`contains="${a.contains}"`);
    lines.push(`- ${a.id}: ${parts.join(' | ')}`);
  }
  lines.push('', `预算：单次工具调用 ${unit.budget.toolCalls}；新文件 ≤${unit.budget.maxLines} 行。`);
  return lines.join('\n');
}
