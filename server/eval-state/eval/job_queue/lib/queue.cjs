/**
 * 有状态队列。规范见入口 impl.cjs 头部注释。
 */
class JobQueue {
  constructor() {
    // items 保持入队顺序；同优先级的先入先出靠「严格大于」比较 + 稳定顺序保证。
    this.items = [];
    this.done = [];
  }

  add(id, priority) {
    if (typeof id !== 'string' || id.length === 0) return;
    const p = Number.isInteger(priority) ? priority : 0;
    const existing = this.items.find((it) => it.id === id);
    if (existing) {
      // 重复 add：只更新优先级，不重复入队，保留原排队位置。
      existing.priority = p;
      return;
    }
    this.items.push({ id, priority: p });
  }

  run() {
    if (this.items.length === 0) return;
    let best = 0;
    for (let i = 1; i < this.items.length; i += 1) {
      // 严格 > ：同优先级时保留先入队者（FIFO）。
      if (this.items[i].priority > this.items[best].priority) best = i;
    }
    this.done.push(this.items[best].id);
    this.items.splice(best, 1);
  }

  cancel(id) {
    const i = this.items.findIndex((it) => it.id === id);
    if (i >= 0) this.items.splice(i, 1);
  }

  snapshot() {
    // pending 按「下一个执行顺序」：优先级降序，同优先级按入队先后。
    return this.items
      .map((it, idx) => ({ id: it.id, priority: it.priority, idx }))
      .sort((a, b) => b.priority - a.priority || a.idx - b.idx)
      .map(({ id, priority }) => ({ id, priority }));
  }
}

module.exports = { JobQueue };
