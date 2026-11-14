/**
 * 派单取证尾部：把归因要用的机械信号**整条**送到 stdout。
 *
 * 为什么不能只 `sse.slice(-900)`：run_report 后面还跟着 delta / stage / done，
 * 900 字节刚好把 run_report 整条挤出去。实测现场（code-search-glob 第 1 次真实派单）
 * 归因因此读不到 outcome=budget_exhausted，把三次预算耗尽记成 Agent 的实现层失败。
 *
 * 最难发现的是它**不是全盲**：toolCallCount 在 done 事件里、活了下来，
 * 所以循环照样报出正确的工具调用数，只有 outcome / fileChangeCount / statusCode 丢了。
 * 一半字段到得了、一半到不了 —— 截断式取证的典型形态。
 *
 * 口径：关键事件（meta / run_report / done）取**最后一次**出现、整条保留、不做任何转义还原
 * （还原 \\n 会把 JSON 里的字符串改坏）；其余只给一段有界的原始尾部供人回看。
 * 关键事件优先占额度，原始尾部用剩下的，所以总额有界而信号不会被切。
 */

/** 送进循环 stdout 的总上限：够归因用，又不至于把控制台灌满。 */
export const TAIL_LIMIT = 4000;
/** 原始尾部最多给这么多字符（还要再受 TAIL_LIMIT 余量约束）。 */
const RAW_TAIL = 1200;
/**
 * 归因与账本依赖的事件；缺一个都可能让资源层失败被记成能力失败。
 *
 * meta 必须在内，而且必须排在最前：`maxIterations` 在整条 SSE 里**只出现一次**，
 * 就在流头的 meta 事件里（run_report 与 done 都只写 iteration）。少了它，
 * 「天花板低于迭代上限」分支的 `iteration < maxIterations` 永远拿不到右操作数，
 * 于是墙钟/token 耗尽一律落到笼统的 BUDGET_EXHAUSTED + split_task ——
 * 明明该拧旋钮，却一直在喊拆题。实测 2026-11-14 code-search 第 1 次派单：
 * iteration=20 送达了、maxIterations=25 没送达，分支静默失效。
 * 排最前是为了让 readRunFacts 的「取最后一次」仍然拿到 done 里的 iteration=20，
 * 而不是 meta 里的 iteration=1。
 */
const KEY_EVENTS = ['meta', 'run_report', 'done'];

/**
 * @param {string} sse 完整 SSE 原文
 * @returns {string} 有界尾部；空流返回空串，绝不凭空发明信号
 */
export function buildDispatchTail(sse) {
  if (!sse) return '';
  const kept = [];
  for (const name of KEY_EVENTS) {
    const hits = [...sse.matchAll(new RegExp(`event: ${name}\\r?\\ndata: (.+)`, 'g'))];
    const last = hits[hits.length - 1];
    if (last) kept.push(`event: ${name}\ndata: ${last[1]}`);
  }
  const head = kept.length > 0 ? `${kept.join('\n\n')}\n\n── 原始尾部 ──\n\n` : '── 原始尾部 ──\n\n';
  const room = Math.max(0, TAIL_LIMIT - head.length);
  return head + sse.slice(-Math.min(RAW_TAIL, room));
}