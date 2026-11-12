/**
 * toRoman：整数转罗马数字。
 *
 * 规范：
 *   1) 只接受 1..3999 的整数；否则抛出错误，错误信息里必须包含 "range"；
 *   2) 使用减法记法（4=IV、9=IX、40=XL、90=XC、400=CD、900=CM）。
 *
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
function toRoman(n) {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 3999) {
    throw new Error('toRoman: input out of range, expected an integer in 1..3999');
  }

  const table = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
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
