/**
 * 从围栏输出里挑出「结论 + 支撑它的证据行」。
 *
 * 为什么不能只取 /^(FAIL|WARN)/：围栏把失败用例名、原始输出落盘路径**缩进**打在
 * FAIL 之后，只取顶格结论行会把证据整段丢掉。诊断书于是只剩一句「可复现真回归」，
 * 下一轮既看不到红了哪些文件、也看不到证据存在哪 —— 实测（2026-11-14）据此
 * 朝错方向重派了三轮，而落盘的 full-regression-*.txt 里失败项一直写得很清楚。
 *
 * REGRESSION_VERDICT= 也要带上：它区分「跑了且红」与「取证缺失（unexec）」，
 * 这两件事的责任人不同，丢掉它等于让下游把没跑读成跑红。
 */
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** 诊断书是给模型吃的，不是日志转储：封顶 24 行，够放下 6 条结论各自的证据。 */
const MAX_LINES = 24;

export function pickFenceEvidence(fenceOut) {
  const lines = String(fenceOut ?? '')
    .replace(ANSI_CSI, '')
    .split('\n');
  const picked = [];
  for (let i = 0; i < lines.length && picked.length < MAX_LINES; i += 1) {
    const line = lines[i];
    if (!/^(FAIL|WARN)\s/.test(line) && !/^REGRESSION_VERDICT=/.test(line.trim())) continue;
    picked.push(line.trim());
    // 紧随其后的缩进行属于这条结论；遇到顶格行（下一条结论 / PASS）就停。
    while (i + 1 < lines.length && picked.length < MAX_LINES && /^\s+\S/.test(lines[i + 1])) {
      i += 1;
      picked.push(lines[i].trim());
    }
  }
  return picked;
}