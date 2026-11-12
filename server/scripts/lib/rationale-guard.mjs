/**
 * 「改代码顺手删掉说明动机的注释」闸。
 *
 * 现场（2026-11-12 第四轮，fs-read-maxbytes）：
 * 靶子里的注释写得很清楚 ——
 *   「原来默认 256 KiB……256 KiB 在这三条（磁盘读放大 / tool_results 归档 /
 *     SSE data 全量推送卡渲染）上都是纯浪费」，所以常量被刻意降到 16 KiB，
 *   过期的是 schema 描述里的 262144。
 * 出题 Agent 却把常量改回 262144，并且**把那 4 行说明动机的注释删了**，
 * 再把注释改写成支持自己结论的版本。判据全绿、tsc 全绿——因为它把反证删了。
 *
 * 这类改动机械可查：diff 里被删掉的注释若带「为什么这么改」的措辞
 * （原来/因为/否则/纯浪费/刻意/权衡…），就必须有人解释它。
 * 与其相信它「读过并理解了」，不如让它先把证据留在场上。
 *
 * 用 .mjs（无类型标注）而不是 .ts：check-self-upgrade.mjs 是纯 node 脚本，
 * 直接 import .ts 跑不起来。类型由 tests/rationale-guard.test.ts 覆盖。
 */

/** 一行注释里出现这些词，说明它在解释「为什么这样设计」，而不是描述代码做了什么。 */
const WHY_MARKERS = [
  '原来',
  '原本',
  '因为',
  '所以',
  '否则',
  '故意',
  '刻意',
  '权衡',
  '纯浪费',
  '避免',
  '防止',
  '历史遗留',
  'deliberate',
  'because',
  'otherwise',
  'trade-off',
  'intentionally',
];

/**
 * 判断一行源码是不是注释（行注释或块注释内的行）。
 * @param {string} text
 * @returns {boolean}
 */
export function isCommentLine(text) {
  const t = text.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('#');
}

/**
 * 从 unified diff 文本里取出「被删除的、解释动机的注释行」。
 * 只看 `-` 开头且不是 `---` 的行；`+` 行不看（新增注释不构成证据销毁）。
 * @param {string} diffText
 * @returns {string[]}
 */
export function deletedRationaleComments(diffText) {
  const out = [];
  for (const raw of diffText.split('\n')) {
    if (!raw.startsWith('-') || raw.startsWith('---')) continue;
    const body = raw.slice(1);
    if (!isCommentLine(body)) continue;
    const lower = body.toLowerCase();
    if (!WHY_MARKERS.some((m) => lower.includes(m.toLowerCase()))) continue;
    const s = body.trim();
    if (!out.includes(s)) out.push(s);
  }
  return out;
}
