/**
 * 围栏布尔 → 归因的判据。
 *
 * 这组用例钉的是「反馈说错了方向」这一类错 —— 它不是能力问题，但会直接
 * 制造能力问题：模型照着错的 note 改，越改越偏。
 *
 * 三个实测现场（2026-11-12，fs-write-delete-recursive-missing-schema 第 2/3 轮）：
 *   1. tsc 报 TS2322（kind 写成非法枚举），围栏因此**跳过**全量回归；
 *      归因把「没跑」读成「跑了且红」→ FULL_SUITE_RED。
 *   2. 随之而来的 note 是「新增工具没登记、把回归失败用例喂回去」——
 *      而根本没有回归失败。模型照着去查注册表，两轮白跑。
 *   3. 更早的三道题（test-run 等）判据夹具一次删 50 个文件，被 safe-delete
 *      拦住，每条断言都收到策略拒绝；却被记成 BEHAVIOR_WRONG 并计入 Agent。
 */

import { describe, expect, it } from 'vitest';
import { attributeFailure, pickErrorLine, type AttributionInput } from '../scripts/failure-attribution.js';

const base: AttributionInput = {
  taskId: 'fence-order-probe',
  attempt: 1,
  maxAttempts: 3,
  dispatch: { exitOk: true, output: '' },
  diagnosis: '',
  fence: {
    reached: true,
    targetChanged: true,
    typeOk: true,
    judgeOk: true,
    fullOk: true,
    protectedIntact: true,
    judgeTampered: false,
  },
  serviceHealthy: true,
};

const TS2322 =
  'src/tools/builtin/fs-write.tool.ts(89,3): error TS2322: Type \'{ ok: false; summary: string; error: { code: string; kind: "precondition_failed"; message: string; }; }\' is not assignable to type \'ToolOutcome\'.';

describe('类型红优先于全量回归（顺序错会指错方向）', () => {
  it('tsc 红 + 全量回归被跳过 → TYPECHECK_RED，不是 FULL_SUITE_RED', () => {
    const a = attributeFailure({
      ...base,
      diagnosis: `【编译器报错】\n${TS2322}\n\n【围栏结论】\nFAIL  类型检查未通过（1 处）`,
      fence: { ...base.fence, typeOk: false, typeRan: true, fullOk: false, fullRan: false },
    });
    expect(a.code).toBe('TYPECHECK_RED');
    expect(a.layer).toBe('integration');
    // 反馈必须点名真实的编译器错误，而不是套「回归被踩坏」的模板
    expect(a.note).toContain('TS2322');
    expect(a.note).not.toContain('回归');
    expect(a.evidence.join('\n')).toContain('TS2322');
  });

  it('类型红与回归红同时出现（回归真的跑过）→ 仍归 TYPECHECK_RED', () => {
    const a = attributeFailure({
      ...base,
      diagnosis: `${TS2322}\nFAIL  tests/x.test.ts > y`,
      fence: { ...base.fence, typeOk: false, fullOk: false, fullRan: true },
    });
    expect(a.code).toBe('TYPECHECK_RED');
  });

  it('类型绿 + 回归真的跑红 → FULL_SUITE_RED，且 note 带失败用例名', () => {
    const a = attributeFailure({
      ...base,
      diagnosis: 'FAIL  tests/self-upgrade/k16.test.ts > K16 新增带 path 参数的工具必须被自动捕获覆盖',
      fence: { ...base.fence, typeOk: true, typeRan: true, fullOk: false, fullRan: true },
    });
    expect(a.code).toBe('FULL_SUITE_RED');
    expect(a.note).toContain('k16.test.ts');
    expect(a.countsAgainstAgent).toBe(true);
  });

  it('老调用方不传 fullRan/typeRan 时语义不变（缺省按「跑过」处理）', () => {
    const a = attributeFailure({
      ...base,
      diagnosis: TS2322,
      fence: { ...base.fence, typeOk: false, fullOk: false },
    });
    expect(a.code).toBe('TYPECHECK_RED');
  });
});

describe('判据夹具被安全策略拦住 → 尺子问题，不是能力问题', () => {
  const blockedOnce = '[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":50}';
  const blockedMany = Array.from({ length: 5 }, () => `→ ${blockedOnce}`).join('\n');

  it('同一句策略拒绝铺满多条断言 → judge/JUDGE_FIXTURE_BLOCKED，跳过本题', () => {
    const a = attributeFailure({ ...base, diagnosis: `【判据未通过：10 条】\n${blockedMany}` });
    expect(a.layer).toBe('judge');
    expect(a.code).toBe('JUDGE_FIXTURE_BLOCKED');
    expect(a.nextAction).toBe('skip_task');
    expect(a.countsAgainstAgent).toBe(false);
    expect(a.note).toContain('mkdtemp');
  });

  it('金丝雀：只出现一次策略拒绝时不许洗白（那可能正是被测行为）', () => {
    const a = attributeFailure({
      ...base,
      diagnosis: `【判据未通过：1 条】\n→ ${blockedOnce}`,
    });
    expect(a.code).not.toBe('JUDGE_FIXTURE_BLOCKED');
    expect(a.countsAgainstAgent).toBe(true);
  });

  it('金丝雀：真正写错行为的实现失败仍记 implementation 并计入 Agent', () => {
    const a = attributeFailure({
      ...base,
      diagnosis: 'FAIL  tests/self-upgrade/x.test.ts > delete dir\nAssertionError: expected 500 to be 400',
    });
    expect(a.layer).toBe('implementation');
    expect(a.code).toBe('BEHAVIOR_WRONG');
    expect(a.countsAgainstAgent).toBe(true);
    expect(a.note).toContain('expected 500 to be 400');
  });
});

describe('pickErrorLine', () => {
  it('编译器错误优先于其它行', () => {
    expect(pickErrorLine('FAIL  a.test.ts\n' + TS2322)).toContain('TS2322');
  });

  it('判据诊断「用例名 + → 差异」成对取出（原先 to match 会漏，只剩围栏那句）', () => {
    const d = [
      '【判据未通过：1 条】',
      '· fsWriteTool replace should fail with location info',
      "  → expected 'oldText 命中 2 处' to match /line\\s*\\d+/i",
      '',
      '【围栏结论】',
      'FAIL  判据未通过：tests/self-upgrade/x.test.ts',
    ].join('\n');
    const line = pickErrorLine(d);
    expect(line).toContain('should fail with location info');
    expect(line).toContain('to match');
    // 不允许退化成「这题没过」这种没有信息量的行
    expect(line).not.toContain('【围栏结论】');
  });

  it('没有编译器错误时取失败用例行', () => {
    expect(pickErrorLine('tests 1 failed\nFAIL  b.test.ts > c')).toBe('FAIL  b.test.ts > c');
  });

  it('只有断言差异时取断言行', () => {
    expect(pickErrorLine('AssertionError: expected false to be true')).toContain('expected false to be true');
  });

  it('什么都没有 → null（不编造证据）', () => {
    expect(pickErrorLine('【围栏结论】\n靶子一个字节都没变')).toBeNull();
  });

  it('超长行截断到 220 字符，避免把整段类型错误塞进日志', () => {
    const long = `src/a.ts(1,1): error TS2322: ${'x'.repeat(400)}`;
    const got = pickErrorLine(long);
    expect(got).not.toBeNull();
    expect((got ?? '').length).toBeLessThanOrEqual(221);
    expect(got).toContain('…');
  });
});
