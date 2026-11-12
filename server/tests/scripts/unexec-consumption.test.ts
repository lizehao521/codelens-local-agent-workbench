/**
 * unexec 消费链路的机械验收（尺子侧 P0，对话第 9/10 轮收敛）：
 * 1. 判据执行三态分类：有 Tests 计数 = 真跑过；没有 = unexec（缺证据即未执行）。
 * 2. 账本失败两桶：infra/budget/behavior/spec/judge = 尺子没跑；
 *    integration/implementation = 跑了没过。unexec 不计入能力账。
 * 3. 回灌摘要行格式（CodeLens 第 11 轮给的模板）。
 */
import { describe, expect, it } from 'vitest';
import { classifyJudgeRun } from '../../scripts/lib/judge-run-classify.mjs';
import { bucketFailures, verdictsLine, RULER_NOT_REACHED_LAYERS } from '../../scripts/lib/failure-buckets.mjs';

describe('classifyJudgeRun：判据三态', () => {
  it('退出码 0 → pass', () => {
    expect(classifyJudgeRun('Tests  7 passed (7)', true)).toEqual({ status: 'pass', ran: true });
  });

  it('有失败计数 → fail（真跑过）', () => {
    const out = 'Test Files  1 failed (1)\n     Tests  2 failed | 5 passed (7)';
    expect(classifyJudgeRun(out, false)).toEqual({ status: 'fail', ran: true });
  });

  it('全失败无 passed 段 → fail', () => {
    expect(classifyJudgeRun('Tests  3 failed (3)', false).status).toBe('fail');
  });

  it('只有 Test Files 红、无 Tests 计数（加载失败）→ unexec', () => {
    const out = 'Test Files  1 failed (1)\nError: Failed to load url ./judge.ts';
    expect(classifyJudgeRun(out, false)).toEqual({ status: 'unexec', ran: false });
  });

  it('No test found → unexec', () => {
    expect(classifyJudgeRun('No test found in suite', false).status).toBe('unexec');
  });

  it('编译错 → unexec', () => {
    expect(classifyJudgeRun('SyntaxError: Unexpected token', false).status).toBe('unexec');
  });

  it('空输出 → unexec（缺证据即未执行）', () => {
    expect(classifyJudgeRun('', false).status).toBe('unexec');
    expect(classifyJudgeRun(undefined, false).status).toBe('unexec');
  });

  it('Tests 0 passed 0 failed → unexec（零用例不算跑过）', () => {
    expect(classifyJudgeRun('Tests  0 passed (0)', false).status).toBe('unexec');
  });
});

describe('bucketFailures：账本两桶', () => {
  const row = (layer: string, task = 't') => ({ verdict: 'failed', layer, task, code: 'X' });

  it('五层归 unexec，两层归 ranFailed', () => {
    const failures = [
      ...RULER_NOT_REACHED_LAYERS.map((l) => row(l)),
      row('implementation'),
      row('integration'),
    ];
    const { unexec, ranFailed } = bucketFailures(failures);
    expect(unexec).toHaveLength(5);
    expect(ranFailed).toHaveLength(2);
    expect(ranFailed.every((f) => ['implementation', 'integration'].includes(f.layer))).toBe(true);
  });

  it('空账本两桶皆空', () => {
    expect(bucketFailures([])).toEqual({ unexec: [], ranFailed: [] });
  });

  it('gaps 只列 unexec 项的题号', () => {
    const { unexec } = bucketFailures([row('infra', 'a'), row('behavior', 'b'), row('implementation', 'c')]);
    const line = verdictsLine({ unexec: unexec.length, fail: 1, pass: 2, gaps: [...new Set(unexec.map((f) => f.task))] });
    expect(line).toBe('verdicts: unexec=2 fail=1 pass=2 | gaps: a, b');
  });

  it('无 gaps 时占位 (无)', () => {
    expect(verdictsLine({ unexec: 0, fail: 0, pass: 0, gaps: [] })).toBe('verdicts: unexec=0 fail=0 pass=0 | gaps: (无)');
  });
});