/**
 * 单行解析。规范见入口 impl.cjs 头部注释。
 */
function parseRow(line) {
  const parts = String(line).split(',').map((p) => p.trim());
  // 合法列数为 3（sku,qty,unitPrice）或 4（多一个 discount）；多列视为非法行。
  if (parts.length < 3 || parts.length > 4) return null;
  const sku = parts[0];
  const qtyNum = Number(parts[1]);
  const priceNum = Number(parts[2]);
  const discNum = parts.length > 3 ? Number(parts[3]) : 0;
  const finite = (n) => typeof n === 'number' && Number.isFinite(n);
  if (!sku) return null;
  if (!finite(qtyNum) || !Number.isInteger(qtyNum) || qtyNum < 1) return null;
  if (!finite(priceNum) || priceNum < 0) return null;
  if (!finite(discNum) || discNum < 0 || discNum > 1) return null;
  return { sku, qty: qtyNum, unitPrice: priceNum, discount: discNum };
}

function isBlank(line) {
  return String(line).trim() === '';
}

module.exports = { parseRow, isBlank };
