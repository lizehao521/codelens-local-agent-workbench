/**
 * 单文件行数棘轮的纯判定逻辑。
 *
 * 为什么是「棘轮」而不是「一刀切 300 行」：本机实测 server/src 有 34 个文件超 300 行、
 * client/src 有 15 个（最大 1550 行）。一刀切等于闸从诞生起就红 49 处，结局是被人关掉；
 * 不管等于没有闸。棘轮的语义是：**存量按现状封顶，只许缩不许涨；增量一律 ≤300。**
 *
 * 四条口径（每条都对应一种真实坏法）：
 *   1. **扫到 0 个文件 = UNEXEC，不是通过。** 跑错目录时扫描结果为空，
 *      若判绿就成了「什么都没量到却宣布达标」（C4）。
 *   2. **清单里有、磁盘上没有 = 红。** 否则删掉一个大文件、再在同路径新建一个，
 *      就能继承旧的巨大上限——棘轮被绕开。
 *   3. **上限只能下调，不能上调。** tighten 用 min，改成 max 就是「把尺子刻度改大」。
 *   4. **缩到 300 以内要报「可出清单」。** 棘轮必须能收紧，否则清单只增不减，
 *      最后变成一份谁也不看的豁免名单。
 */

export const DEFAULT_LIMIT = 300;

/**
 * @param files  实测 [{file, lines}]，file 用仓库相对 posix 路径
 * @param entries 棘轮清单 [{file, ceiling}]
 * @returns {results, failures, stale, graduated, passed, scanned, unexec}
 */
export function evaluate(files, entries, limit = DEFAULT_LIMIT) {
  const scanned = files.length;
  if (scanned === 0) {
    return { results: [], failures: [], stale: [], graduated: [], passed: 0, scanned, unexec: true };
  }

  const ceilingOf = new Map(entries.map((e) => [e.file, e.ceiling]));
  const linesOf = new Map(files.map((f) => [f.file, f.lines]));

  const results = files.map(({ file, lines }) => {
    const ceiling = ceilingOf.get(file);
    if (ceiling === undefined) {
      const over = lines > limit;
      return {
        file,
        lines,
        ceiling: null,
        status: over ? 'fail' : 'pass',
        reason: over ? `新文件 ${lines} 行 > ${limit}，且不在棘轮清单里` : null,
      };
    }
    const over = lines > ceiling;
    return {
      file,
      lines,
      ceiling,
      status: over ? 'fail' : 'pass',
      reason: over ? `比棘轮上限 ${ceiling} 多了 ${lines - ceiling} 行（只许缩不许涨）` : null,
    };
  });

  // 清单里的孤儿：必须红，见口径 2。
  const stale = entries
    .filter((e) => !linesOf.has(e.file))
    .map((e) => ({
      file: e.file,
      lines: null,
      ceiling: e.ceiling,
      status: 'fail',
      reason: '清单里有它、磁盘上没有：删除或重命名后必须同步清单，否则同路径新建可继承旧上限',
    }));

  const graduated = entries
    .filter((e) => linesOf.has(e.file) && linesOf.get(e.file) <= limit)
    .map((e) => ({ file: e.file, lines: linesOf.get(e.file), ceiling: e.ceiling }));

  const failures = [...results.filter((r) => r.status === 'fail'), ...stale];
  return {
    results,
    failures,
    stale,
    graduated,
    passed: results.filter((r) => r.status === 'pass').length,
    scanned,
    unexec: false,
  };
}

/** 把清单上限下调到实测值（绝不上调）。文件不在实测里则原样保留，交给 evaluate 判孤儿。 */
export function tighten(entries, files) {
  const linesOf = new Map(files.map((f) => [f.file, f.lines]));
  return entries.map((e) => {
    const now = linesOf.get(e.file);
    return now === undefined ? { ...e } : { ...e, ceiling: Math.min(e.ceiling, now) };
  });
}