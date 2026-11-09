/**
 * 评测执行器 —— 在 node:vm 里跑沙箱中的实现，按服务端用例打分。
 *
 * 为什么用 vm 而不是 `import()` / `require()`：
 *  - 同步：JudgeService.judge() 是同步方法，异步断言会让判决悬空；
 *  - 隔离：上下文里没有 require / process / fs，Agent 写的实现拿不到宿主机能力；
 *  - 可超时：每次调用都带 vm timeout，死循环实现不会把判决进程拖死。
 *
 * 每次测量都用**全新上下文**，模块级状态不跨套件、不跨代残留。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EVAL_SUITES, type EvalCase, type EvalSuite } from './suites.js';

export interface EvalCaseFailure {
  name: string;
  expected: string;
  actual: string;
  /** true = 隐藏用例，只进分数、不回显详情给 Agent。 */
  hidden: boolean;
}

export interface EvalSuiteResult {
  id: string;
  title: string;
  ok: boolean;
  passed: number;
  total: number;
  publicPassed: number;
  publicTotal: number;
  failures: EvalCaseFailure[];
  /** 实现文件缺失 / 加载失败等套件级错误。 */
  error?: string;
}

export interface EvalBatteryResult {
  passed: number;
  total: number;
  /** 0–1；total=0 时为 0。 */
  score: number;
  suites: EvalSuiteResult[];
}

const CASE_TIMEOUT_MS = 1000;
const MODULE_TIMEOUT_MS = 1000;
const SNIPPET_CAP = 200;

/** 跨 realm 安全的安全深比较：不依赖原型链，数组/普通对象逐键比。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function snippet(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > SNIPPET_CAP ? `${text.slice(0, SNIPPET_CAP)}…` : text;
}

interface RunOutcome {
  pass: boolean;
  expected: string;
  actual: string;
}

/** 在给定上下文里跑一条用例。期望抛错时检查错误信息子串。 */
function runCase(ctx: vm.Context, c: EvalCase): RunOutcome {
  const expectThrow = typeof c.throws === 'string';
  const expected = expectThrow ? `throws(${c.throws})` : snippet(c.expected);
  try {
    (ctx as Record<string, unknown>).__args = c.args;
    vm.runInContext('__result = module.exports[__name](...__args)', ctx, {
      timeout: CASE_TIMEOUT_MS,
    });
    const actualValue = (ctx as Record<string, unknown>).__result;
    if (expectThrow) {
      return { pass: false, expected, actual: `未抛错，返回 ${snippet(actualValue)}` };
    }
    return { pass: deepEqual(actualValue, c.expected), expected, actual: snippet(actualValue) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (expectThrow) {
      return message.includes(c.throws as string)
        ? { pass: true, expected, actual: `throws(${message})` }
        : { pass: false, expected, actual: `throws(${message})` };
    }
    return { pass: false, expected, actual: `throws(${message})` };
  }
}

/**
 * 跑单套件。
 * @param includeHidden true = 判据口径（public + hidden 全量）；false = Agent 可见口径。
 */
export function runSuite(
  sandboxRoot: string,
  suite: EvalSuite,
  includeHidden: boolean,
): EvalSuiteResult {
  const abs = path.join(sandboxRoot, suite.implPath);
  const base: EvalSuiteResult = {
    id: suite.id,
    title: suite.title,
    ok: false,
    passed: 0,
    total: 0,
    publicPassed: 0,
    publicTotal: 0,
    failures: [],
  };

  if (!existsSync(abs)) {
    return { ...base, error: `实现文件不存在：${suite.implPath}` };
  }

  let source: string;
  try {
    source = readFileSync(abs, 'utf8');
  } catch (err) {
    return { ...base, error: `读取失败：${err instanceof Error ? err.message : String(err)}` };
  }

  const cases = includeHidden
    ? [...suite.publicCases, ...suite.hiddenCases]
    : [...suite.publicCases];
  const hiddenFrom = suite.publicCases.length;

  const moduleShim = { exports: {} as Record<string, unknown> };
  const ctx = vm.createContext({
    module: moduleShim,
    exports: moduleShim.exports,
    __name: suite.exportName,
    __args: [] as unknown[],
    __result: undefined as unknown,
  });

  try {
    vm.runInContext(source, ctx, { timeout: MODULE_TIMEOUT_MS, filename: abs });
  } catch (err) {
    return {
      ...base,
      total: cases.length,
      publicTotal: suite.publicCases.length,
      error: `加载失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const exported = (ctx as Record<string, unknown>).module as
    | { exports?: Record<string, unknown> }
    | undefined;
  const fn = exported?.exports?.[suite.exportName];
  if (typeof fn !== 'function') {
    return {
      ...base,
      total: cases.length,
      publicTotal: suite.publicCases.length,
      error: `module.exports.${suite.exportName} 不是函数（必须保持 CommonJS 导出）`,
    };
  }

  let passed = 0;
  let publicPassed = 0;
  const failures: EvalCaseFailure[] = [];
  cases.forEach((c, index) => {
    const hidden = index >= hiddenFrom;
    const outcome = runCase(ctx, c);
    if (outcome.pass) {
      passed += 1;
      if (!hidden) publicPassed += 1;
    } else {
      failures.push({ name: c.name, expected: outcome.expected, actual: outcome.actual, hidden });
    }
  });

  return {
    ...base,
    ok: passed === cases.length,
    passed,
    total: cases.length,
    publicPassed,
    publicTotal: suite.publicCases.length,
    failures,
  };
}

/** 跑全部固定套件。判据用 includeHidden=true，Agent 可见口径也用它（只回显 public）。 */
export function runEvalBattery(
  sandboxRoot: string,
  options: { includeHidden?: boolean; only?: string } = {},
): EvalBatteryResult {
  const includeHidden = options.includeHidden ?? true;
  const suites = EVAL_SUITES.filter((s) => !options.only || s.id === options.only).map((s) =>
    runSuite(sandboxRoot, s, includeHidden),
  );
  const passed = suites.reduce((sum, s) => sum + s.passed, 0);
  const total = suites.reduce((sum, s) => sum + s.total, 0);
  return {
    passed,
    total,
    score: total === 0 ? 0 : Math.round((passed / total) * 1000) / 1000,
    suites,
  };
}
