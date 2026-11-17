/**
 * inventory_rollup：把 CSV 行汇总成 SKU 级台账。跨三个文件协作：
 *   impl.cjs         —— 入口 rollup(lines)：聚合、排序、汇总
 *   lib/parse.cjs    —— parseRow(line)：解析单行
 *   lib/pricing.cjs  —— lineGross / applyTier / round2：计价
 */
const { parseRow, isBlank } = require('./lib/parse.cjs');
const { round2, lineGross, applyTier } = require('./lib/pricing.cjs');

function rollup(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const bySku = new Map();
  let skipped = 0;

  for (const line of list) {
    if (isBlank(line)) continue; // 整行空白：跳过，且不计入 skipped
    const row = parseRow(line);
    if (!row) {
      skipped += 1;
      continue;
    }
    const cur = bySku.get(row.sku) || { sku: row.sku, qty: 0, gross: 0 };
    cur.qty += row.qty;
    cur.gross += lineGross(row);
    bySku.set(row.sku, cur);
  }

  const items = [];
  for (const cur of bySku.values()) {
    // 批量折扣按「合并后的 qty」判定，不是单行 qty。
    items.push({
      sku: cur.sku,
      qty: cur.qty,
      total: round2(applyTier(cur.qty, cur.gross)),
    });
  }
  items.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  const total = round2(items.reduce((sum, it) => sum + it.total, 0));
  return { items, skipped, total };
}

module.exports = { rollup };
