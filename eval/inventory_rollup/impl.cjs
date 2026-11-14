/**
 * inventory_rollup：把 CSV 行汇总成 SKU 级台账。跨三个文件协作：
 *   impl.cjs         —— 入口 rollup(lines)：聚合、排序、汇总
 *   lib/parse.cjs    —— parseRow(line)：解析单行
 *   lib/pricing.cjs  —— lineGross / applyTier / round2：计价
 *
 * 规范：
 *   1) 每行形如 "sku,qty,unitPrice[,discount]"；字段两侧空白要去掉；
 *      整行为空（或全是空白）直接跳过，不计入 skipped。
 *   2) 合法行要求：sku 非空；qty 是 >= 1 的整数；unitPrice 是 >= 0 的有限数；
 *      discount 缺省为 0，若给出必须是 0..1 的有限数。不合法 → 计入 skipped。
 *   3) 行金额 = qty * unitPrice * (1 - discount)。
 *   4) 同一 sku 的多行要合并：qty 相加、金额相加。
 *   5) 合并后的 qty >= 10 时，该 sku 金额再打 95 折。
 *   6) 金额保留两位小数（四舍五入）：Math.round(x * 100) / 100。
 *   7) 返回 { items, skipped, total }：items 按 sku 升序，每项 { sku, qty, total }；
 *      total = 各 item 的 total 之和再保留两位小数。
 *
 * 当前实现有真实缺陷（分布在三个文件里）—— 这是真实缺陷，不是注释错误。
 * 三个文件都是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
const { parseRow, isBlank } = require('./lib/parse.cjs');
const { round2, lineGross, applyTier } = require('./lib/pricing.cjs');

function rollup(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const items = [];
  let skipped = 0;
  for (const line of list) {
    if (isBlank(line)) {
      skipped += 1;
      continue;
    }
    const row = parseRow(line);
    if (!row) {
      skipped += 1;
      continue;
    }
    items.push({
      sku: row.sku,
      qty: row.qty,
      total: round2(applyTier(row.qty, lineGross(row))),
    });
  }
  const total = items.reduce((sum, it) => sum + it.total, 0);
  return { items, skipped, total };
}

module.exports = { rollup };
