/**
 * rsi_report_parse：从 RSI 报告中解析「指标行」。规范：
 *
 *   - 指标行形如：  · metric.name：0.6 → 1（变好=true）
 *     其中冒号既可能是全角「：」(U+FF1A)，也可能是半角「:」。
 *   - 提取 { metric, before, after, better }；better 取自「变好=true/false」。
 *   - 行尾可能附带额外括号（如「（护栏：不得变差）」），须忽略。
 *   - 只抓取含「·」且含「→」的行；其它行（判定/退出码/读数说明）忽略。
 *   - 入参非字符串、空串 → 返回 []。
 *
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
function parseMetricLines(input) {
  if (typeof input !== 'string') return [];
  const out = [];
  const re = /^\s*[·•]\s*([^\s：:]+)\s*[：:]\s*([\d.]+)\s*→\s*([\d.]+)\s*（变好=(true|false)）/;
  for (const line of input.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    out.push({
      metric: m[1],
      before: Number(m[2]),
      after: Number(m[3]),
      better: m[4] === 'true',
    });
  }
  return out;
}

module.exports = { parseMetricLines };
