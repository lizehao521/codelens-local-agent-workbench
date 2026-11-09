/**
 * toRoman：整数转罗马数字。
 *
 * 规范：
 *   1) 只接受 1..3999 的整数；否则抛出错误，错误信息里必须包含 "range"；
 *   2) 使用减法记法（4=IV、9=IX、40=XL、90=XC、400=CD、900=CM）。
 *
 * 当前实现是纯加法式（4 会输出 IIII），也没有任何取值范围校验 —— 都是真实缺陷。
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
function toRoman(n) {
  const table = [
    [1000, 'M'],
    [500, 'D'],
    [100, 'C'],
    [50, 'L'],
    [10, 'X'],
    [5, 'V'],
    [1, 'I'],
  ];
  let rest = n;
  let out = '';
  for (const [value, symbol] of table) {
    while (rest >= value) {
      out += symbol;
      rest -= value;
    }
  }
  return out;
}

module.exports = { toRoman };
