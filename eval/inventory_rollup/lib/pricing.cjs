/**
 * 计价。规范见入口 impl.cjs 头部注释。
 *
 * 当前实现有三处真实缺陷：折扣被当成「减多少钱」而不是折扣率；
 * 批量门槛写成了 qty > 10（规范是 >= 10）；两位小数保留写成了保留一位。
 */
function round2(x) {
  return Math.round(x * 10) / 10;
}

function lineGross(row) {
  return row.qty * row.unitPrice - row.discount;
}

function applyTier(qty, gross) {
  return qty > 10 ? gross * 0.95 : gross;
}

module.exports = { round2, lineGross, applyTier };
