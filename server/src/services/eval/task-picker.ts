/**
 * 任务选择 · 按当前分数挑下一道题。
 *
 * 替代 `tasks[i % tasks.length]` 的固定轮转。实测固定轮转有两个缺陷：
 *   1) 撞上已满分的套件（inventory_rollup 13/13），Agent 无事可做，那一代白跑；
 *   2) 有未满分的套件永远轮不到（slugify_edge_cases 4/7 过去没有任务文本）。
 *
 * 边界：这里只决定**选哪道题**（确定性、可复现），不决定怎么修。
 * 与 `--auto` 模式（让 Agent 自己从失败列表里挑）是两条不同的路，不要混用。
 */

export interface SuiteScoreLike {
  id: string;
  passed: number;
  total: number;
}

export interface PickedTask {
  task: string;
  id: string;
  why: string;
}

/** 从任务文本里取出它点名的套件 id（`修复 eval/<id>/...`）。 */
export function suiteIdOfTask(task: string): string | null {
  const m = /eval\/([a-z0-9_]+)\//.exec(task);
  return m ? (m[1] ?? null) : null;
}

/**
 * 按分数选题。
 *
 * 排序键（依次）：
 *   1. 是否满分 —— 满分排最后（没活可干）
 *   2. 本次运行内是否试过 —— 试过的排后（换一道题才能拿到新信息）
 *   3. 通过率 —— 低的优先（收益空间大）
 *   4. 题数 —— 多的优先（同样差距下修的用例更多）
 *
 * 第 2 条排在第 3 条前面是刻意的：在一个修不动的题上连着撞墙，
 * 不会比换一道题更有价值，只会让整轮运行只覆盖一个套件。
 */
export function pickTaskByScore(
  tasks: string[],
  suites: SuiteScoreLike[],
  attempted: Set<string> = new Set(),
): PickedTask | null {
  const byId = new Map(suites.map((s) => [s.id, s]));
  const candidates: { task: string; id: string }[] = [];
  for (const task of tasks) {
    const id = suiteIdOfTask(task);
    if (id && byId.has(id)) candidates.push({ task, id });
  }
  if (!candidates.length) return null;

  const key = (id: string) => {
    const s = byId.get(id)!;
    return {
      full: s.passed >= s.total ? 1 : 0,
      tried: attempted.has(id) ? 1 : 0,
      rate: s.total === 0 ? 1 : s.passed / s.total,
      size: -s.total,
    };
  };

  candidates.sort((a, b) => {
    const ka = key(a.id);
    const kb = key(b.id);
    return ka.full - kb.full || ka.tried - kb.tried || ka.rate - kb.rate || ka.size - kb.size;
  });

  const best = candidates[0]!;
  const s = byId.get(best.id)!;
  const why =
    s.passed >= s.total
      ? `全部套件已满分，选 ${best.id}（${s.passed}/${s.total}）做回归确认`
      : `${best.id} ${s.passed}/${s.total}，当前最差且本次未尝试`;
  return { task: best.task, id: best.id, why };
}
