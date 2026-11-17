/**
 * job_queue：按操作序列驱动一个有状态的任务队列。跨两个文件协作：
 *   impl.cjs        —— runQueue(ops)：按顺序把操作喂给队列，返回最终快照
 *   lib/queue.cjs   —— JobQueue 类：add / run / cancel / snapshot
 */
const { JobQueue } = require('./lib/queue.cjs');

function runQueue(ops) {
  const queue = new JobQueue();
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'add') queue.add(op.id, op.priority);
    else if (op.op === 'run') queue.run();
    else if (op.op === 'cancel') queue.cancel(op.id);
  }
  return { done: queue.done.slice(), pending: queue.snapshot() };
}

module.exports = { runQueue };
