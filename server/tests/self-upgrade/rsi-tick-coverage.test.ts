/**
 * 判据 · 账本覆盖率口径（S3 / Judge / C4 不外推）
 *
 * 缺陷背景：`scripts/rsi-tick.mjs` 只要账本行里有 `task` 字段就计入覆盖，分母用全部
 * 题数；`scripts/check-task-metadata.mjs` 要求 `verdict === 'verified'`，分母用 done
 * 题数。本机实测同一份账本（19 行：adopted 13 / failed 4 / aborted 1 / verified 1）
 * 前者报「覆盖 13/13」、后者报「1/13」。
 *
 * 为什么这是缺陷而不是口径偏好：迭代计划把「rsi-tick 覆盖率 ≥ 8/13」列为 P0 完成判据。
 * 把「采纳过」当「验证过」，该判据就被一份没有验证证据的账本满足了——尺子替被衡量者
 * 说了谎。按 C4，未验证的覆盖不得计入。
 *
 * 本判据钉住唯一口径：**covered = done 题 ∩ verdict==='verified' 的题**，分母 = done 题数。
 * 同时要求「提到过」的读数单独保留，修口径不等于丢信息。
 */
import { describe, expect, it } from 'vitest';
import { computeLedgerCoverage } from '../../../scripts/lib/ledger-coverage.mjs';

const done = (id: string) => ({ id, status: 'done' });
const pending = (id: string) => ({ id, status: 'pending' });
const row = (task: string, verdict: string, at = '2026-11-13T00:00:00.000Z') =>
  JSON.stringify({ at, task, verdict });
const ledger = (...rows: string[]) => rows.join('\n');

describe('covered 只认 verified（核心反向断言）', () => {
  it('adopted 不算覆盖：done 题只有 adopted 行 → covered 0', () => {
    const r = computeLedgerCoverage([done('a')], ledger(row('a', 'adopted')));
    expect(r.covered).toBe(0);
    expect(r.coverage).toBe(0);
    expect(r.missing).toEqual(['a']);
  });

  it('failed / aborted 同样不算覆盖', () => {
    for (const verdict of ['failed', 'aborted', 'rejected']) {
      const r = computeLedgerCoverage([done('a')], ledger(row('a', verdict)));
      expect(r.covered).toBe(0);
      expect(r.missing.includes('a')).toBe(true);
    }
  });

  it('verdict 缺失不算覆盖（旧账本行没有该字段）', () => {
    const r = computeLedgerCoverage([done('a')], ledger(JSON.stringify({ task: 'a' })));
    expect(r.covered).toBe(0);
  });

  it('verified 才算覆盖', () => {
    const r = computeLedgerCoverage([done('a')], ledger(row('a', 'verified')));
    expect(r.covered).toBe(1);
    expect(r.coverage).toBe(1);
    expect(r.missing).toEqual([]);
  });

  it('adopted 与 verified 混排：只数 verified 的那题', () => {
    const r = computeLedgerCoverage(
      [done('a'), done('b'), done('c')],
      ledger(row('a', 'adopted'), row('b', 'verified'), row('c', 'adopted')),
    );
    expect(r.covered).toBe(1);
    expect(r.missing).toEqual(['a', 'c']);
  });

  it('同一题先 adopted 后 verified → 算覆盖（终态可推进）', () => {
    const r = computeLedgerCoverage([done('a')], ledger(row('a', 'adopted'), row('a', 'verified')));
    expect(r.covered).toBe(1);
  });

  it('重复 verified 行去重，不重复计数', () => {
    const r = computeLedgerCoverage([done('a')], ledger(row('a', 'verified'), row('a', 'verified')));
    expect(r.covered).toBe(1);
    expect(r.lines).toBe(2);
  });
});

describe('分母只数 done 题', () => {
  it('pending 题不进分母', () => {
    const r = computeLedgerCoverage([done('a'), pending('b')], ledger(row('a', 'verified')));
    expect(r.doneCount).toBe(1);
    expect(r.coverage).toBe(1);
  });

  it('pending 题即使有 verified 行也不计入 covered', () => {
    const r = computeLedgerCoverage([pending('b')], ledger(row('b', 'verified')));
    expect(r.doneCount).toBe(0);
    expect(r.covered).toBe(0);
    expect(r.coverage).toBe(0);
  });

  it('全 pending 时 coverage 为 0，不产生除零', () => {
    const r = computeLedgerCoverage([pending('a'), pending('b')], null);
    expect(r.coverage).toBe(0);
    expect(Number.isNaN(r.coverage)).toBe(false);
  });

  it('账本题外多余 verified 行不虚增覆盖', () => {
    const r = computeLedgerCoverage([done('a')], ledger(row('a', 'verified'), row('ghost', 'verified')));
    expect(r.covered).toBe(1);
    expect(r.coverage).toBe(1);
  });
});

describe('修口径不丢信息：提到过 / 坏行 / 时间戳', () => {
  it('mentionedTasks 保留「提到过」的题数，与 covered 分开报', () => {
    const r = computeLedgerCoverage(
      [done('a'), done('b')],
      ledger(row('a', 'adopted'), row('b', 'verified')),
    );
    expect(r.mentionedTasks).toBe(2);
    expect(r.covered).toBe(1);
    expect(r.mentionedTasks === r.covered).toBe(false);
  });

  it('无 task 字段的 infra 行不计入 mentionedTasks', () => {
    const infra = JSON.stringify({ at: '2026-11-12T13:06:44.132Z', verdict: 'aborted', layer: 'infra' });
    const r = computeLedgerCoverage([done('a')], ledger(infra, row('a', 'verified')));
    expect(r.mentionedTasks).toBe(1);
    expect(r.lines).toBe(2);
  });

  it('坏行计入 lines 与 badLines，但不参与覆盖', () => {
    const r = computeLedgerCoverage([done('a')], ledger('{ not json', row('a', 'verified')));
    expect(r.lines).toBe(2);
    expect(r.badLines).toBe(1);
    expect(r.covered).toBe(1);
  });

  it('lastAt 取最大值，不受行序影响', () => {
    const r = computeLedgerCoverage(
      [done('a')],
      ledger(row('a', 'verified', '2026-11-13T10:00:00.000Z'), row('a', 'adopted', '2026-11-11T10:00:00.000Z')),
    );
    expect(r.lastAt).toBe('2026-11-13T10:00:00.000Z');
  });

  it('CRLF 与 LF 同口径（Windows 检出不得改读数）', () => {
    const lf = computeLedgerCoverage([done('a')], ledger(row('a', 'adopted'), row('a', 'verified')));
    const crlf = computeLedgerCoverage(
      [done('a')],
      [row('a', 'adopted'), row('a', 'verified')].join('\r\n'),
    );
    expect(crlf.covered).toBe(lf.covered);
    expect(crlf.lines).toBe(lf.lines);
    expect(crlf.badLines).toBe(0);
  });

  it('空行不计入 lines', () => {
    const r = computeLedgerCoverage([done('a')], `\n\n${row('a', 'verified')}\n\n`);
    expect(r.lines).toBe(1);
    expect(r.badLines).toBe(0);
  });
});

describe('账本不可得：报 0 而不是猜', () => {
  it('null → 全 0，由调用方判 UNEXEC', () => {
    const r = computeLedgerCoverage([done('a')], null);
    expect(r.lines).toBe(0);
    expect(r.covered).toBe(0);
    expect(r.lastAt).toBe(null);
    expect(r.missing).toEqual(['a']);
  });

  it('空字符串账本 → 0 覆盖，missing 列出全部 done 题', () => {
    const r = computeLedgerCoverage([done('a'), done('b')], '');
    expect(r.covered).toBe(0);
    expect(r.missing).toEqual(['a', 'b']);
  });

  it('空题集 → coverage 0，不抛错', () => {
    const r = computeLedgerCoverage([], ledger(row('a', 'verified')));
    expect(r.doneCount).toBe(0);
    expect(r.coverage).toBe(0);
    expect(r.covered).toBe(0);
  });
});

describe('不变量（反向断言）', () => {
  const tasks = [done('a'), done('b'), pending('c')];
  const text = ledger(
    row('a', 'verified'),
    row('b', 'verified'),
    row('c', 'verified'),
    row('ghost', 'verified'),
  );

  it('covered 不得超过 doneCount', () => {
    const r = computeLedgerCoverage(tasks, text);
    expect(r.covered > r.doneCount).toBe(false);
    expect(r.covered).toBe(2);
  });

  it('coverage 不得越出 [0,1]', () => {
    const r = computeLedgerCoverage(tasks, text);
    expect(r.coverage > 1).toBe(false);
    expect(r.coverage < 0).toBe(false);
  });

  it('已覆盖的题不得出现在 missing 里', () => {
    const r = computeLedgerCoverage(tasks, text);
    expect(r.missing.includes('a')).toBe(false);
    expect(r.missing.includes('b')).toBe(false);
    expect(r.missing).toEqual([]);
  });

  it('题集顺序不影响读数（covered 与 missing 均按题集序）', () => {
    const forward = computeLedgerCoverage(tasks, text);
    const reversed = computeLedgerCoverage([...tasks].reverse(), text);
    expect(reversed.covered).toBe(forward.covered);
    expect(reversed.coverage).toBe(forward.coverage);
  });
});

describe('覆盖率精度', () => {
  it('保留三位小数', () => {
    const tasks = [done('a'), done('b'), done('c')];
    const r = computeLedgerCoverage(tasks, ledger(row('a', 'verified')));
    expect(r.coverage).toBe(0.333);
  });

  it('coverage 与 covered/doneCount 自洽', () => {
    const tasks = [done('a'), done('b'), done('c'), done('d')];
    const r = computeLedgerCoverage(tasks, ledger(row('a', 'verified'), row('b', 'adopted')));
    expect(r.coverage).toBe(0.25);
    expect(r.covered / r.doneCount).toBe(r.coverage);
  });
});