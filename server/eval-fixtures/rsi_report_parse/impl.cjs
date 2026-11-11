/**
 * RSI 报告「逐指标对比行」解析器 —— **缺陷夹具（待修起点）**。
 *
 * 输入：krsi 输出的报告全文（多行字符串）。
 * 输出：按出现顺序排列的数组，每项 { metric, before, after, better }。
 *
 * 规范（必须全部满足）：
 * 1) 报告里每条指标行形如：
 *      "  · <指标名>：<旧值> → <新值>（变好=<true|false>）<可选尾巴>"
 *    分隔指标名与数值用的冒号在实际报告里是**全角「：」**。
 * 2) 必须同时兼容全角「：」与半角「:」两种写法 —— 历史报告里两种都出现过，
 *    只认其中一种会让另一批报告整批解析不出来。
 * 3) before / after 转成 Number；better 为布尔（"true" 为 true，其余为 false）。
 * 4) 行首允许任意空白；不以「·」开头的行一律忽略。
 * 5) 指标名内不含空白；指标名之后的尾巴（如「（护栏：不得变差）」）忽略。
 * 6) 没有任何命中时返回空数组 []；入参不是字符串时也返回 []。
 *
 * 导出：module.exports.parseMetricLines = parseMetricLines
 */

function parseMetricLines(report) {
  const out = [];
  if (typeof report !== 'string') return out;

  // 缺陷：只认半角冒号，且指标名贪婪到行尾 —— 真实报告用的全角「：」一条都抓不到，
  // 尾巴也会把 better 字段吃掉。修法见 src/services/rsi/rsi-bridge.service.ts。
  const metricLine = /^\s*·\s+(.+)\s*:\s*([\d.]+)\s*→\s*([\d.]+)\s*（变好=(\w+)）/;

  for (const line of report.split(/\r?\n/)) {
    const m = line.match(metricLine);
    if (m && m[1] !== undefined) {
      out.push({
        metric: m[1].trim(),
        before: Number(m[2]),
        after: Number(m[3]),
        better: m[4] === 'true',
      });
    }
  }
  return out;
}

module.exports.parseMetricLines = parseMetricLines;
