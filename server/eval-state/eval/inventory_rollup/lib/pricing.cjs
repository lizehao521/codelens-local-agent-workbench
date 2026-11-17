/**
 * 计价。规范见入口 impl.cjs 头部注释。
 */
function round2(x) {
  return Math.round(x * 100) / 100;
}

function lineGross(row) {
  // discount 是折扣率（0..1），作用在单价上，不是「减多少钱」。
  return row.qty * row.unitPrice * (1 - row.discount);
}

function applyTier(qty, gross) {
  // 门槛是合并后的 qty >= 10。
  return qty >= 10 ? gross * 0.95 : gross;
}

module.exports = { round2, lineGross, applyTier };
