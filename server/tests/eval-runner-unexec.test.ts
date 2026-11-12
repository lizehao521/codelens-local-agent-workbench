/**
 * eval runner 的 unexec 语义（尺子侧 P0）：
 * 「尺子没跑」（实现缺失/加载失败）与「跑了没过」必须分开——
 * unexec 不进 score 分母，也不谎报 publicPassed。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runSourceCases, runSuite, runEvalBattery } from '../src/services/eval/runner.js';
import { EVAL_SUITES } from '../src/services/eval/suites.js';

const CASES = [
  { name: 'a', args: [1], expected: 2 },
  { name: 'b', args: [2], expected: 3 },
];

const GOOD_SLUGIFY = "module.exports.slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n";

const sandboxes: string[] = [];
function makeSandbox(slugifyImpl?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'unexec-test-'));
  sandboxes.push(dir);
  if (slugifyImpl !== undefined) {
    mkdirSync(path.join(dir, 'eval', 'slugify'), { recursive: true });
    writeFileSync(path.join(dir, 'eval', 'slugify', 'impl.cjs'), slugifyImpl, 'utf8');
  }
  return dir;
}
afterAll(() => {
  for (const d of sandboxes) rmSync(d, { recursive: true, force: true });
});

const slugify = EVAL_SUITES.find((s) => s.id === 'slugify')!;
const slugifyCaseCount = slugify.publicCases.length + slugify.hiddenCases.length;

describe('runSourceCases：加载失败 = 全量 unexec', () => {
  it('语法错 → unexec=total，不是全 fail', () => {
    const r = runSourceCases('this is not js {{{', 'fn', CASES);
    expect(r.error).toBeDefined();
    expect(r.unexec).toBe(CASES.length);
    expect(r.passed).toBe(0);
    expect(r.failures).toHaveLength(0);
  });

  it('导出不是函数 → unexec=total', () => {
    const r = runSourceCases('module.exports.fn = 42;', 'fn', CASES);
    expect(r.unexec).toBe(CASES.length);
    expect(r.error).toContain('不是函数');
  });

  it('正常执行 → unexec=0，失败进 failures', () => {
    const r = runSourceCases('module.exports.fn = (x) => x + 1;', 'fn', CASES);
    expect(r.unexec).toBe(0);
    expect(r.passed).toBe(2);
    const bad = runSourceCases('module.exports.fn = (x) => x;', 'fn', CASES);
    expect(bad.unexec).toBe(0);
    expect(bad.failures).toHaveLength(2);
  });
});

describe('runSuite：缺失/加载失败/真失败 三种口径', () => {
  it('实现缺失 → total=定义用例数，unexec=total，publicPassed=0', () => {
    const dir = makeSandbox();
    const r = runSuite(dir, slugify, true);
    expect(r.error).toContain('不存在');
    expect(r.total).toBe(slugifyCaseCount);
    expect(r.unexec).toBe(slugifyCaseCount);
    expect(r.publicPassed).toBe(0);
    expect(r.publicTotal).toBe(slugify.publicCases.length);
  });

  it('加载失败 → unexec=total，publicPassed 不谎报全过', () => {
    const dir = makeSandbox('module.exports.slugify = {{{');
    const r = runSuite(dir, slugify, true);
    expect(r.error).toBeDefined();
    expect(r.unexec).toBe(slugifyCaseCount);
    expect(r.publicPassed).toBe(0);
  });

  it('跑起来但全错 → unexec=0，失败是真失败', () => {
    const dir = makeSandbox("module.exports.slugify = () => 'wrong';");
    const r = runSuite(dir, slugify, true);
    expect(r.error).toBeUndefined();
    expect(r.unexec).toBe(0);
    expect(r.passed).toBe(0);
    expect(r.failures.length).toBe(slugifyCaseCount);
  });

  it('全对 → unexec=0，ok=true', () => {
    const dir = makeSandbox(GOOD_SLUGIFY);
    const r = runSuite(dir, slugify, true);
    expect(r.ok).toBe(true);
    expect(r.unexec).toBe(0);
    expect(r.passed).toBe(slugifyCaseCount);
  });
});

describe('runEvalBattery：score 分母只算已执行用例', () => {
  it('空沙箱 → 全部 unexec，score=0，unexec=total', () => {
    const dir = makeSandbox();
    const r = runEvalBattery(dir, { includeHidden: true });
    expect(r.unexec).toBe(r.total);
    expect(r.total).toBeGreaterThan(0);
    expect(r.score).toBe(0);
    expect(r.failureKinds.suite_error).toBe(r.suites.length);
  });

  it('只有一个套件跑起来且全对 → score=1，unexec=其余套件', () => {
    const dir = makeSandbox(GOOD_SLUGIFY);
    const r = runEvalBattery(dir, { includeHidden: true });
    expect(r.unexec).toBe(r.total - slugifyCaseCount);
    expect(r.passed).toBe(slugifyCaseCount);
    expect(r.score).toBe(1);
  });

  it('唯一实现加载失败 → 该套件也归 unexec，score=0', () => {
    const dir = makeSandbox('module.exports.slugify = {{{');
    const r = runEvalBattery(dir, { includeHidden: true });
    expect(r.unexec).toBe(r.total);
    expect(r.score).toBe(0);
  });

  it('跑起来但全错 → 不进 unexec，拉低 score', () => {
    const dir = makeSandbox("module.exports.slugify = () => 'wrong';");
    const r = runEvalBattery(dir, { includeHidden: true });
    expect(r.unexec).toBe(r.total - slugifyCaseCount);
    expect(r.score).toBe(0);
    expect(r.failureKinds.public_fail).toBeGreaterThanOrEqual(1);
  });
});