/**
 * mergeIntervals：合并重叠或相接的区间。
 *
 * 规范：
 *   1) 输入任意顺序，先按起点升序排列；
 *   2) 重叠 **或相接**（下一段起点 <= 当前段终点）都合并；
 *   3) start > end 的非法区间直接忽略；
 *   4) 不许修改入参数组，返回全新数组。
 *
 * 当前实现没有排序，且把「相接」漏掉了 —— 都是真实缺陷。
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
function mergeIntervals(list) {
  const out = [];
  for (const item of list) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const [s, e] = item;
    if (!Number.isFinite(s) || !Number.isFinite(e) || s > e) continue;
    const last = out[out.length - 1];
    if (last && s < last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

module.exports = { mergeIntervals };
