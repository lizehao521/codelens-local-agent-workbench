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
import { allSuites, type EvalCase, type EvalSuite } from './suites.js';

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

/** 源码级执行的返回值：propose 的变异验证与 suite 打分共用这一份口径。 */
export interface SourceRunResult {
  passed: number;
  total: number;
  failures: EvalCaseFailure[];
  error?: string;
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
 * 直接对一段源码跑用例（不落盘）。
 *
 * @param hiddenFrom 该下标及之后的用例标记为 hidden（只影响失败项标记，不影响计分）
 */
export function runSourceCases(
  source: string,
  exportName: string,
  cases: EvalCase[],
  filename = '<inline>',
  hiddenFrom: number = Number.POSITIVE_INFINITY,
): SourceRunResult {
  const moduleShim = { exports: {} as Record<string, unknown> };
  const ctx = vm.createContext({
    module: moduleShim,
    exports: moduleShim.exports,
    __name: exportName,
    __args: [] as unknown[],
    __result: undefined as unknown,
  });

  try {
    vm.runInContext(source, ctx, { timeout: MODULE_TIMEOUT_MS, filename });
  } catch (err) {
    return {
      passed: 0,
      total: cases.length,
      failures: [],
      error: `加载失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const exported = (ctx as Record<string, unknown>).module as
    | { exports?: Record<string, unknown> }
    | undefined;
  const fn = exported?.exports?.[exportName];
  if (typeof fn !== 'function') {
    return {
      passed: 0,
      total: cases.length,
      failures: [],
      error: `module.exports.${exportName} 不是函数（必须保持 CommonJS 导出）`,
    };
  }

  let passed = 0;
  const failures: EvalCaseFailure[] = [];
  cases.forEach((c, index) => {
    const hidden = index >= hiddenFrom;
    const outcome = runCase(ctx, c);
    if (outcome.pass) passed += 1;
    else failures.push({ name: c.name, expected: outcome.expected, actual: outcome.actual, hidden });
  });

  return { passed, total: cases.length, failures };
}

/**
 * 多文件套件：在同一个 vm 上下文里按 CommonJS 语义加载入口与相对依赖。
 *
 * 为什么不用 require()/import()：那会把宿主机的 require 交给被测实现，
 * 等于把 fs / process 全部暴露出去。这里只提供一个极小的 loader：
 *  - 白名单是 suite.files，只有列出的文件能被 require；
 *  - 只接受相对路径，解析后的绝对路径必须落在白名单里；
 *  - 模块体同样跑在 vm 里（带 timeout），模块级状态在同一上下文中共享 ——
 *    这正是「有状态实现」能被真实检验的前提。
 */
function runMultiFileCases(
  suiteDir: string,
  entryAbs: string,
  suite: EvalSuite,
  cases: EvalCase[],
  hiddenFrom: number,
): SourceRunResult {
  const allowed = new Set<string>([path.resolve(entryAbs)]);
  for (const rel of suite.files ?? []) allowed.add(path.resolve(suiteDir, rel));

  const moduleShim = { exports: {} as Record<string, unknown> };
  const sandbox: Record<string, unknown> = {
    module: moduleShim,
    exports: moduleShim.exports,
    __name: suite.exportName,
    __args: [] as unknown[],
    __result: undefined as unknown,
    __moduleFn: undefined as unknown,
    __moduleShim: undefined as unknown,
    __moduleRequire: undefined as unknown,
  };
  const ctx = vm.createContext(sandbox);
  const cache = new Map<string, { exports: unknown }>();

  const loadModule = (absFile: string): unknown => {
    const key = path.resolve(absFile);
    const cached = cache.get(key);
    if (cached) return cached.exports;
    if (!allowed.has(key)) {
      throw new Error(`不允许加载 ${path.relative(suiteDir, key)}（不在套件 files 白名单内）`);
    }
    let source: string;
    try {
      source = readFileSync(key, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`读取 ${path.relative(suiteDir, key)} 失败：${message}`);
    }
    const mod: { exports: unknown } = { exports: {} };
    cache.set(key, mod); // 先入缓存：循环依赖时拿到的是半成品，而不是无限递归
    const requireFrom = (spec: unknown): unknown => {
      if (typeof spec !== 'string' || !spec.startsWith('.')) {
        throw new Error(`只允许相对路径 require：${String(spec)}`);
      }
      return loadModule(path.resolve(path.dirname(key), spec));
    };
    const wrapped = `(function (module, exports, require) {\n${source}\n})`;
    sandbox.__moduleFn = vm.runInContext(wrapped, ctx, {
      timeout: MODULE_TIMEOUT_MS,
      filename: key,
    });
    sandbox.__moduleShim = mod;
    sandbox.__moduleRequire = requireFrom;
    // 必须经由 runInContext 执行模块体：这样 timeout 才管得住死循环。
    vm.runInContext('__moduleFn(__moduleShim, __moduleShim.exports, __moduleRequire)', ctx, {
      timeout: MODULE_TIMEOUT_MS,
      filename: key,
    });
    return mod.exports;
  };

  let entryExports: unknown;
  try {
    entryExports = loadModule(entryAbs);
  } catch (err) {
    return {
      passed: 0,
      total: cases.length,
      failures: [],
      error: `加载失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const exportedName = suite.exportName;
  const fn =
    entryExports !== null && typeof entryExports === 'object'
      ? (entryExports as Record<string, unknown>)[exportedName]
      : undefined;
  if (typeof fn !== 'function') {
    return {
      passed: 0,
      total: cases.length,
      failures: [],
      error: `module.exports.${exportedName} 不是函数（必须保持 CommonJS 导出）`,
    };
  }
  // runCase 统一从 module.exports 取函数：把入口模块挂回上下文即可复用同一口径。
  sandbox.module = { exports: entryExports };

  let passed = 0;
  const failures: EvalCaseFailure[] = [];
  cases.forEach((c, index) => {
    const outcome = runCase(ctx, c);
    if (outcome.pass) passed += 1;
    else {
      failures.push({
        name: c.name,
        expected: outcome.expected,
        actual: outcome.actual,
        hidden: index >= hiddenFrom,
      });
    }
  });
  return { passed, total: cases.length, failures };
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

  const cases = includeHidden
    ? [...suite.publicCases, ...suite.hiddenCases]
    : [...suite.publicCases];
  const hiddenFrom = suite.publicCases.length;

  let result: SourceRunResult;
  if (suite.files && suite.files.length > 0) {
    result = runMultiFileCases(path.dirname(abs), abs, suite, cases, hiddenFrom);
  } else {
    let source: string;
    try {
      source = readFileSync(abs, 'utf8');
    } catch (err) {
      return { ...base, error: `读取失败：${err instanceof Error ? err.message : String(err)}` };
    }
    result = runSourceCases(source, suite.exportName, cases, abs, hiddenFrom);
  }

  const publicTotal = suite.publicCases.length;
  const publicFailures = result.failures.filter((f) => !f.hidden).length;
  return {
    ...base,
    ok: result.error === undefined && result.passed === result.total,
    passed: result.passed,
    total: result.total,
    publicTotal,
    publicPassed: Math.max(0, publicTotal - publicFailures),
    failures: result.failures,
    ...(result.error ? { error: result.error } : {}),
  };
}

/** 跑全部固定套件（内置 + 已晋升的提案套件）。 */
export function runEvalBattery(
  sandboxRoot: string,
  options: { includeHidden?: boolean; only?: string } = {},
): EvalBatteryResult {
  const includeHidden = options.includeHidden ?? true;
  const suites = allSuites(sandboxRoot)
    .filter((s) => !options.only || s.id === options.only)
    .map((s) => runSuite(sandboxRoot, s, includeHidden));
  const passed = suites.reduce((sum, s) => sum + s.passed, 0);
  const total = suites.reduce((sum, s) => sum + s.total, 0);
  return {
    passed,
    total,
    score: total === 0 ? 0 : Math.round((passed / total) * 1000) / 1000,
    suites,
  };
}
