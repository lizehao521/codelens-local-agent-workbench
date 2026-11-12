/**
 * 有状态队列。规范见入口 impl.cjs 头部注释。
 *
 * 当前实现有三处真实缺陷：add 不做去重、同优先级时后入先出（LIFO）、
 * cancel 是空实现。这些缺陷只有跨多个操作才能暴露出来。
 */
class JobQueue {
  constructor() {
    this.items = [];
    this.done = [];
  }

  add(id, priority) {
    this.items.push({ id, priority: Number.isInteger(priority) ? priority : 0 });
  }

  run() {
    if (this.items.length === 0) return;
    let best = 0;
    for (let i = 1; i < this.items.length; i += 1) {
      if (this.items[i].priority >= this.items[best].priority) best = i;
    }
    this.done.push(this.items[best].id);
    this.items.splice(best, 1);
  }

  cancel() {}

  snapshot() {
    return this.items
      .slice()
      .sort((a, b) => b.priority - a.priority)
      .map((it) => ({ id: it.id, priority: it.priority }));
  }
}

module.exports = { JobQueue };
