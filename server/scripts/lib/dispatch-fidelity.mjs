/**
 * 派单通道保真：两件「缺证据不等于反证」的事。
 *
 * 1. readToolCallEvidence —— stdout 里没有 run_report 时，toolCallCount 是**未知**，
 *    不是 0。旧写法 `?? 0` 让循环对着一次上游 404 打印「你只说不做」，
 *    把根本没被派出去的一轮说成模型的行为问题。
 * 2. filterServableRotation —— 换模型的候选必须是上游真实服务的 ID。
 *    主模型刚被 chat 探针实证可用，永远保留；后备候选没被探针验证过，
 *    拿得到 /models 列表就按列表过滤，拿不到就一律放行（无列表接口 ≠ 模型不存在）。
 */

/** 从派单 stdout 里取最后一次 toolCallCount；缺席时 known=false。 */
export function readToolCallEvidence(output) {
  const hits = [...String(output ?? '').matchAll(/"toolCallCount":(\d+)/g)];
  if (hits.length === 0) return { known: false, count: null };
  return { known: true, count: Number(hits[hits.length - 1][1]) };
}

/** 按上游实际服务的模型列表过滤换模型候选。 */
export function filterServableRotation(rotation, served) {
  const [primary, ...rest] = rotation ?? [];
  if (primary === undefined) return { kept: [], dropped: [], verified: false };
  const list = Array.isArray(served) ? served.filter(Boolean) : [];
  if (list.length === 0) return { kept: [...rotation], dropped: [], verified: false };
  const set = new Set(list);
  const kept = [primary];
  const dropped = [];
  for (const m of rest) (set.has(m) ? kept : dropped).push(m);
  return { kept, dropped, verified: true };
}