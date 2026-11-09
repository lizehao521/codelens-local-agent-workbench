/**
 * 固定评测套件 —— 代码修复任务族的「测量仪器」。
 *
 * 设计约束（这是与「让 Agent 自己写测试」最根本的区别）：
 *  - **用例定义在服务端**，Agent 的写权限只在沙箱里，所以它改不到判据；
 *  - 每套用例分 public / hidden 两部分：eval.run 只回显 public 的失败详情，
 *    判据则按 public + hidden 全量打分。只针对 public 打补丁会得到 < 1 的读数，
 *    只有写出通解才能拿满分 —— 这是「防过拟合」而不是「防作弊」措辞上的差别。
 *  - implPath 是沙箱相对路径，Agent 可以读、可以改；判据在判决时重新执行它，
 *    拿到的是「此刻的真实通过率」，不是 Agent 的自述。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface EvalCase {
  /** 用例名，出现在失败列表里。 */
  name: string;
  args: unknown[];
  /** 期望返回值（深比较）。与 throws 互斥。 */
  expected?: unknown;
  /** 期望抛出异常，值为错误信息必须包含的子串。 */
  throws?: string;
}

export interface EvalSuite {
  id: string;
  title: string;
  /** 沙箱相对路径：被测实现。 */
  implPath: string;
  /** 实现文件里要调用的导出名。 */
  exportName: string;
  /** 公开用例：eval.run 会回显它们的失败详情。 */
  publicCases: EvalCase[];
  /** 隐藏用例：只在判据里参与打分，不回显。 */
  hiddenCases: EvalCase[];
}

/** eval.run 的展示名。判据用它判断「本轮到底有没有真跑过评测」。 */
export const EVAL_RUN_DISPLAY_NAME = '运行评测';

export const EVAL_SUITES: readonly EvalSuite[] = [
  {
    id: 'slugify',
    title: '标题转 slug',
    implPath: 'eval/slugify/impl.cjs',
    exportName: 'slugify',
    publicCases: [
      { name: '普通空格', args: ['Hello World'], expected: 'hello-world' },
      { name: '首尾空格与多空格', args: ['  Hello   World  '], expected: 'hello-world' },
    ],
    hiddenCases: [
      { name: '标点折叠', args: ['Hello, World!'], expected: 'hello-world' },
      { name: '连续横线折叠', args: ['a--b'], expected: 'a-b' },
      { name: '首尾横线清除', args: ['--Edge--'], expected: 'edge' },
      { name: '大写转小写', args: ['ABC'], expected: 'abc' },
      { name: '混合分隔符', args: ['Node.js 8 Release'], expected: 'node-js-8-release' },
    ],
  },
  {
    id: 'chunk',
    title: '数组切块',
    implPath: 'eval/chunk/impl.cjs',
    exportName: 'chunk',
    publicCases: [
      { name: '保留余数', args: [[1, 2, 3, 4, 5], 2], expected: [[1, 2], [3, 4], [5]] },
      { name: '非法长度必须报错', args: [[1, 2, 3], 0], throws: 'positive' },
    ],
    hiddenCases: [
      { name: '空数组', args: [[], 3], expected: [] },
      { name: '总量小于块长', args: [[1], 3], expected: [[1]] },
      { name: '整除无余数', args: [[1, 2, 3, 4], 2], expected: [[1, 2], [3, 4]] },
      { name: '负数长度必须报错', args: [[1], -1], throws: 'positive' },
    ],
  },
  {
    id: 'parse_kv',
    title: '键值串解析',
    implPath: 'eval/parse_kv/impl.cjs',
    exportName: 'parseKV',
    publicCases: [
      { name: '基础两对', args: ['a=1;b=2'], expected: { a: '1', b: '2' } },
      { name: '键值两侧空白', args: [' a = 1 ; b = 2 '], expected: { a: '1', b: '2' } },
    ],
    hiddenCases: [
      { name: '跳过空段', args: ['a=1;;b=2'], expected: { a: '1', b: '2' } },
      { name: '值为空', args: ['a='], expected: { a: '' } },
      { name: '缺少等号', args: ['a'], expected: { a: '' } },
      { name: '同键后者覆盖', args: ['a=1;a=2'], expected: { a: '2' } },
      { name: '空输入', args: [''], expected: {} },
      { name: '值内含等号', args: ['a=1=2'], expected: { a: '1=2' } },
    ],
  },
  {
    id: 'interval_merge',
    title: '区间合并',
    implPath: 'eval/interval_merge/impl.cjs',
    exportName: 'mergeIntervals',
    publicCases: [
      {
        name: '重叠区间合并',
        args: [[[1, 3], [2, 6], [8, 10], [15, 18]]],
        expected: [[1, 6], [8, 10], [15, 18]],
      },
      { name: '空数组', args: [[]], expected: [] },
    ],
    hiddenCases: [
      { name: '乱序输入先排序', args: [[[5, 7], [1, 3]]], expected: [[1, 3], [5, 7]] },
      { name: '相接区间也要合并', args: [[[1, 2], [2, 3]]], expected: [[1, 3]] },
      { name: '被完全包含', args: [[[1, 10], [2, 3]]], expected: [[1, 10]] },
      { name: '非法区间忽略', args: [[[3, 1], [5, 6]]], expected: [[5, 6]] },
      { name: '单点区间', args: [[[2, 2]]], expected: [[2, 2]] },
    ],
  },
  {
    id: 'parse_query',
    title: 'URL 查询串解析',
    implPath: 'eval/parse_query/impl.cjs',
    exportName: 'parseQuery',
    publicCases: [
      { name: '剥离问号', args: ['?a=1&b=2'], expected: { a: '1', b: '2' } },
      { name: '百分号解码', args: ['a=hello%20world'], expected: { a: 'hello world' } },
    ],
    hiddenCases: [
      { name: '无等号的段', args: ['?flag'], expected: { flag: '' } },
      { name: '同键后者覆盖', args: ['a=1&a=2'], expected: { a: '2' } },
      { name: '加号转空格', args: ['?a=x+y'], expected: { a: 'x y' } },
      { name: '跳过空段', args: ['&&a=1&&'], expected: { a: '1' } },
      { name: '中文解码', args: ['a=%E4%B8%AD'], expected: { a: '中' } },
      { name: '空输入', args: [''], expected: {} },
    ],
  },
  {
    id: 'to_roman',
    title: '整数转罗马数字',
    implPath: 'eval/to_roman/impl.cjs',
    exportName: 'toRoman',
    publicCases: [
      { name: '减法记法 4', args: [4], expected: 'IV' },
      { name: '减法记法 9', args: [9], expected: 'IX' },
    ],
    hiddenCases: [
      { name: '最小值 1', args: [1], expected: 'I' },
      { name: '1994', args: [1994], expected: 'MCMXCIV' },
      { name: '上限 3999', args: [3999], expected: 'MMMCMXCIX' },
      { name: '44', args: [44], expected: 'XLIV' },
      { name: '0 越界', args: [0], throws: 'range' },
      { name: '4000 越界', args: [4000], throws: 'range' },
      { name: '非整数', args: [3.5], throws: 'range' },
    ],
  },
];

/** 按 id 取套件；未知 id 返回 undefined。 */
export function findSuite(id: string): EvalSuite | undefined {
  return EVAL_SUITES.find((s) => s.id === id);
}

/**
 * 已晋升套件的存放目录 —— **沙箱之外、且进版本管理**（server/eval-suites）。
 *
 * 为什么不能放沙箱里：Agent 有 fs.write 权限，若套件定义在沙箱内，
 * 它可以直接写一个「用例恒真」的套件给自己满分。判据必须放在它改不到的地方。
 * 为什么不放 data/：data/ 是 gitignore 的运行时目录，沙箱重置就没了；
 * 套件定义是实验资产，必须能跟仓库一起活下去。
 */
export function suiteStoreDir(sandboxRoot: string): string {
  return path.resolve(sandboxRoot, '..', 'eval-suites');
}

/**
 * 已晋升的提案套件（Agent 检索 → eval.propose → 变异验证通过 → 落盘到这里）。
 *
 * 与内置套件的区别只是来源：它们在数据目录里，可以随实验迭代增删，
 * 而内置套件是代码里的固定测量面。两者进同一个 battery 打分。
 */
export function promotedSuites(sandboxRoot: string): EvalSuite[] {
  const dir = suiteStoreDir(sandboxRoot);
  if (!existsSync(dir)) return [];
  const out: EvalSuite[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as EvalSuite;
      if (
        raw &&
        typeof raw.id === 'string' &&
        typeof raw.implPath === 'string' &&
        typeof raw.exportName === 'string' &&
        Array.isArray(raw.publicCases) &&
        Array.isArray(raw.hiddenCases)
      ) {
        out.push(raw);
      }
    } catch {
      /* 单个坏文件跳过：一条脏数据不该拖垮整代测量 */
    }
  }
  return out;
}

/** 全部生效套件（内置 + 已晋升）。 */
export function allSuites(sandboxRoot: string): EvalSuite[] {
  return [...EVAL_SUITES, ...promotedSuites(sandboxRoot)];
}
