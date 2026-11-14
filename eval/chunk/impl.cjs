/**
 * chunk：把数组按固定长度切块。
 *
 * 规范：
 *   1) size 必须是正整数，否则抛出错误，错误信息里必须包含 "positive"；
 *   2) 不足一块的剩余元素必须保留成最后一块；
 *   3) 空数组返回空数组。
 *
 * 当前实现有两个真实缺陷：丢弃余数；size<=0 时静默返回空数组而不是报错。
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
function chunk(list, size) {
  if (size <= 0) return [];
  const out = [];
  for (let i = 0; i + size <= list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

module.exports = { chunk };
