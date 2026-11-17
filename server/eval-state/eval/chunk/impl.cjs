/**
 * chunk：把数组按固定长度切块。
 *
 * 规范：
 *   1) size 必须是正整数，否则抛出错误，错误信息里必须包含 "positive"；
 *   2) 不足一块的剩余元素必须保留成最后一块；
 *   3) 空数组返回空数组。
 *
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
function chunk(list, size) {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('size must be a positive integer');
  }
  const out = [];
  const arr = Array.isArray(list) ? list : [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

module.exports = { chunk };
