/**
 * 单行解析。规范见入口 impl.cjs 头部注释。
 *
 * 当前实现只做了「按逗号切开 + Number()」，没有 trim，也没有校验 qty / 价格 /
 * 折扣的合法区间 —— 这些缺陷会让非法行混进台账。
 */
function parseRow(line) {
  const parts = String(line).split(',');
  if (parts.length < 3) return null;
  return {
    sku: parts[0],
    qty: Number(parts[1]),
    unitPrice: Number(parts[2]),
    discount: parts.length > 3 ? Number(parts[3]) : 0,
  };
}

function isBlank(line) {
  return String(line).trim() === '';
}

module.exports = { parseRow, isBlank };
