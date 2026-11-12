/**
 * 账本失败的两桶分类：尺子没跑（unexec）vs 跑了没过（ranFailed）。
 *
 * 口径与 failure-attribution 的分层原则一致：只有 integration / implementation
 * 两层是「判据真跑过、产物被打红」；其余五层（infra/budget/behavior/spec/judge）
 * 的失败发生在判据给出判决之前——围栏没跑到、或尺子本身无效。把前者记成
 * 「Agent 没过判据」会污染学习信号（宣言 §6：unexec 是一等状态）。
 */
export const RULER_NOT_REACHED_LAYERS = ['infra', 'budget', 'behavior', 'spec', 'judge'];

export function bucketFailures(failures) {
  const unexec = [];
  const ranFailed = [];
  for (const f of failures) {
    (RULER_NOT_REACHED_LAYERS.includes(f.layer) ? unexec : ranFailed).push(f);
  }
  return { unexec, ranFailed };
}

/** 回灌用单行摘要：让下一轮一眼分清「尺子没跑」和「我没修对」。 */
export function verdictsLine({ unexec, fail, pass, gaps }) {
  const list = gaps && gaps.length ? gaps.join(', ') : '(无)';
  return `verdicts: unexec=${unexec} fail=${fail} pass=${pass} | gaps: ${list}`;
}