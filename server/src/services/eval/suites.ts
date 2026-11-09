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
];

/** 按 id 取套件；未知 id 返回 undefined。 */
export function findSuite(id: string): EvalSuite | undefined {
  return EVAL_SUITES.find((s) => s.id === id);
}
