/**
 * job_queue：按操作序列驱动一个有状态的任务队列。跨两个文件协作：
 *   impl.cjs        —— runQueue(ops)：按顺序把操作喂给队列，返回最终快照
 *   lib/queue.cjs   —— JobQueue 类：add / run / cancel / snapshot
 *
 * 规范：
 *   1) 操作序列按顺序执行；未知 op 忽略。
 *   2) add { id, priority? }：id 必须是非空字符串，否则忽略；
 *      priority 缺省 0，非整数按 0 处理。
 *      同一 id 已在排队 → 只更新优先级，不重复入队，且保留原排队位置。
 *   3) run：取出当前优先级最高的任务执行（同优先级按入队先后，先入先出），
 *      按执行顺序记入 done；队列为空时 run 无副作用。
 *   4) cancel { id }：把该 id 从排队中移除；不存在则忽略。
 *      取消后可以重新 add —— 重新入队排到队尾。
 *   5) 返回 { done, pending }：pending 是剩余任务按「下一个执行顺序」排列的快照，
 *      每项 { id, priority }。
 *
 * 当前实现有真实缺陷（队列语义层面）—— 这是真实缺陷，不是注释错误。
 * 两个文件都是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
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
