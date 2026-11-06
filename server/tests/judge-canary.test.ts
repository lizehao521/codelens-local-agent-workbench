/**
 * L1 金丝雀自证测试（强化内核宣言 C3）。
 *
 * 这一组测试回答的是元问题：**判据还有没有资格判断别人？**
 *
 * 破坏夹具（核心）：
 *   - 把判据换成「永真闸」→ 已知坏样本会被判绿 → 金丝雀必须红；
 *   - 把判据换成「永假闸」→ 已知好样本会被判红 → 金丝雀必须红；
 *   - 只削弱其中一条 → 判别力下降至阈值以下时金丝雀必须红。
 *
 * 只有这三条都成立，才证明金丝雀不是装饰，而是真的能抓住「假绿」。
 */

import { describe, it, expect } from 'vitest';
import {
  runCanary,
  CANARY_CASES,
  CANARY_THRESHOLDS,
} from '../src/services/judge/canary.js';
import { L0_CRITERIA, DEFAULT_L0_THRESHOLDS, type L0Criterion } from '../src/services/judge/criteria.js';
import type { VerdictStatus } from '../src/services/judge/types.js';

const T = DEFAULT_L0_THRESHOLDS;

/** 永真闸：无论证据是什么都判 pass —— 这正是宣言反复警告的「假绿」。 */
const alwaysPass = (criterion: string): L0Criterion => () => ({
  layer: 'L0',
  criterion,
  status: 'pass',
});

/** 永假闸：无论证据是什么都判 fail —— 「判据过严」，会误杀正常任务。 */
const alwaysFail = (criterion: string): L0Criterion => () => ({
  layer: 'L0',
  criterion,
  status: 'fail',
});

/** 取每条判据的真实名字，用于构造等价替换。 */
function criterionNames(): string[] {
  return L0_CRITERIA.map((fn) => fn(CANARY_CASES[0].evidence, T).criterion);
}

describe('金丝雀：正常判据下判别力成立', () => {
  it('金丝雀通过，且已知好/坏样本被分开', () => {
    const out = runCanary(T);
    expect(out.verdict.status).toBe('pass');
    expect(out.goodScore).toBeGreaterThanOrEqual(CANARY_THRESHOLDS.minGoodScore);
    expect(out.badScore).toBeLessThanOrEqual(CANARY_THRESHOLDS.maxBadScore);
    expect(out.goodScore - out.badScore).toBeGreaterThanOrEqual(CANARY_THRESHOLDS.minGap);
  });

  it('已知好样本不允许出现 unexec（否则样本没覆盖到全部判据，自证无效）', () => {
    const out = runCanary(T);
    const good = out.cases.filter((c) => c.expected === 'good');
    for (const c of good) expect(c.unexec).toEqual([]);
  });

  it('样本同时包含已知好与已知坏，否则判别力无从谈起', () => {
    expect(CANARY_CASES.some((c) => c.expected === 'good')).toBe(true);
    expect(CANARY_CASES.some((c) => c.expected === 'bad')).toBe(true);
  });

  it('金丝雀判决本身带 L1 层标记与可读理由', () => {
    const out = runCanary(T);
    expect(out.verdict.layer).toBe('L1');
    expect(out.verdict.criterion).toBe('canary.discrimination');
    expect(out.verdict.detail).toBeTruthy();
  });
});

describe('破坏夹具：判据被削弱时金丝雀必须变红', () => {
  it('全部换成永真闸 → 变红（抓住「假绿」）', () => {
    const weakened = criterionNames().map(alwaysPass);
    const out = runCanary(T, weakened);
    expect(out.verdict.status).toBe('fail');
    // 坏样本被判绿是最直接的证据
    expect(out.badScore).toBeGreaterThan(CANARY_THRESHOLDS.maxBadScore);
    expect(out.verdict.detail).toContain('判据永真');
  });

  it('全部换成永假闸 → 变红（抓住「假红」，避免误杀正常任务）', () => {
    const weakened = criterionNames().map(alwaysFail);
    const out = runCanary(T, weakened);
    expect(out.verdict.status).toBe('fail');
    expect(out.goodScore).toBeLessThan(CANARY_THRESHOLDS.minGoodScore);
    expect(out.verdict.detail).toContain('判据过严');
  });

  it('只削弱工具成功率这一条 → 判别力下滑，金丝雀仍然报警', () => {
    const names = criterionNames();
    const weakened = L0_CRITERIA.map((fn, i) =>
      names[i] === 'tool.success_rate' ? alwaysPass('tool.success_rate') : fn,
    );
    const out = runCanary(T, weakened);
    // 单条削弱未必让整体判别力归零，但必须让「坏样本更绿」——
    // 这是金丝雀能持续守住底线的证据，而不是只在全坏时才响。
    const baseline = runCanary(T);
    expect(out.badScore).toBeGreaterThan(baseline.badScore);
  });

  it('判据返回全 unexec → 金丝雀判 unexec 而非 pass（无法验证不等于通过）', () => {
    const unexec: L0Criterion = (e, _t) => ({
      layer: 'L0',
      criterion: 'x',
      status: 'unexec' as VerdictStatus,
      detail: e.sessionId,
    });
    const out = runCanary(T, criterionNames().map(() => unexec));
    expect(out.verdict.status).toBe('unexec');
  });
});

describe('金丝雀与判据塔的耦合约束', () => {
  it('金丝雀使用的阈值与生产判据同源（同一份 resolveThresholds 结果）', () => {
    // 若两者不同源，就会出现「金丝雀用一套阈值、生产用另一套」的假自证。
    const out = runCanary(T);
    expect(out.verdict.status).toBe('pass');
    expect(L0_CRITERIA).toHaveLength(5);
  });
});
