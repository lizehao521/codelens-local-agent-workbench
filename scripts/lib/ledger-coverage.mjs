/**
 * 账本覆盖率的单一真相源。
 *
 * 为什么必须只有一份：rsi-tick 与 C1 元数据闸曾各持一套口径——前者只要行里有
 * `task` 字段就计入覆盖、分母用全部题数；后者要求 `verdict === 'verified'`、
 * 分母用 done 题数。同一份账本（adopted 13 / failed 4 / aborted 1 / verified 1）
 * 前者报「覆盖 13/13」、后者报「1/13」。读数虚高不是小事：它让「账本缺口已闭合」
 * 看起来成立，而按可验证证据其实只闭合了 1 题。两处共用本模块后口径无法再分叉。
 */

/**
 * @param {Array<{id?: unknown, status?: unknown}>} tasks 题集数组
 * @param {string | null} ledgerText 账本原文；null 表示账本不可得（调用方按 UNEXEC 处理）
 */
export function computeLedgerCoverage(tasks, ledgerText) {
  let lines = 0;
  let badLines = 0;
  let lastAt = null;
  const mentioned = new Set();
  const verified = new Set();

  if (typeof ledgerText === 'string') {
    for (const line of ledgerText.split(/\r?\n/)) {
      if (!line.trim()) continue;
      lines += 1;
      try {
        const row = JSON.parse(line);
        if (typeof row.task === 'string') {
          mentioned.add(row.task);
          if (row.verdict === 'verified') verified.add(row.task);
        }
        if (typeof row.at === 'string' && (!lastAt || row.at > lastAt)) lastAt = row.at;
      } catch {
        badLines += 1;
      }
    }
  }

  // 分母是 done 题，不是全部题：pending 题还没做完，谈不上「覆盖」。
  const doneIds = tasks.filter((t) => t.status === 'done' && typeof t.id === 'string').map((t) => t.id);
  const missing = doneIds.filter((id) => !verified.has(id));
  const covered = doneIds.length - missing.length;

  return {
    lines,
    badLines,
    mentionedTasks: mentioned.size,
    doneCount: doneIds.length,
    covered,
    coverage: doneIds.length ? Number((covered / doneIds.length).toFixed(3)) : 0,
    missing,
    lastAt,
  };
}