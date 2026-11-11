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
  /**
   * 多文件套件：入口 implPath 允许 require 的同目录文件（相对套件目录）。
   *
   * 只有列在这里的文件才能被加载 —— 这是白名单，不是提示。
   * 缺省（单文件套件）时入口文件不能 require 任何东西。
   */
  files?: string[];
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
  {
    /*
     * 扩题（第一组）：多文件联动 + 计价口径。
     *
     * 旧题面全是「单文件、纯函数、一个函数体」——Agent 只要盯着一个文件改就行。
     * 这一题的缺陷分散在 parse / pricing / 入口三处：只修入口拿不到分，
     * 只修一个辅助文件也拿不到分，必须先读懂跨文件的调用约定再联动修改。
     * 同时引入两位小数与合并后门槛，覆盖旧的字符串/数组题面碰不到的数值口径。
     */
    id: 'inventory_rollup',
    title: '库存汇总（多文件联动）',
    implPath: 'eval/inventory_rollup/impl.cjs',
    files: ['lib/parse.cjs', 'lib/pricing.cjs'],
    exportName: 'rollup',
    publicCases: [
      {
        name: '单行基础金额',
        args: [['A1,2,3.5']],
        expected: { items: [{ sku: 'A1', qty: 2, total: 7 }], skipped: 0, total: 7 },
      },
      {
        name: '多 SKU 按 sku 升序输出',
        args: [['B2,1,10', 'A1,3,2']],
        expected: {
          items: [
            { sku: 'A1', qty: 3, total: 6 },
            { sku: 'B2', qty: 1, total: 10 },
          ],
          skipped: 0,
          total: 16,
        },
      },
    ],
    hiddenCases: [
      {
        name: '折扣作用在单价上',
        args: [['A1,2,10,0.25']],
        expected: { items: [{ sku: 'A1', qty: 2, total: 15 }], skipped: 0, total: 15 },
      },
      {
        name: 'qty=9 不触发批量折扣',
        args: [['A1,9,1']],
        expected: { items: [{ sku: 'A1', qty: 9, total: 9 }], skipped: 0, total: 9 },
      },
      {
        name: 'qty=10 触发 95 折',
        args: [['A1,10,1']],
        expected: { items: [{ sku: 'A1', qty: 10, total: 9.5 }], skipped: 0, total: 9.5 },
      },
      {
        name: '重复 SKU 合并后按合计 qty 判门槛',
        args: [['A1,6,1', 'A1,4,1']],
        expected: { items: [{ sku: 'A1', qty: 10, total: 9.5 }], skipped: 0, total: 9.5 },
      },
      {
        name: '两位小数四舍五入',
        args: [['A1,1,0.05']],
        expected: { items: [{ sku: 'A1', qty: 1, total: 0.05 }], skipped: 0, total: 0.05 },
      },
      {
        name: '非法行计入 skipped',
        args: [['A1,2,10', 'B2,0,5', 'C3,x,1', 'D4,1,-2', 'E5,1,1,1.5']],
        expected: {
          items: [{ sku: 'A1', qty: 2, total: 20 }],
          skipped: 4,
          total: 20,
        },
      },
      {
        name: '空行跳过且不计 skipped',
        args: [['', '   ', 'A1,1,2']],
        expected: { items: [{ sku: 'A1', qty: 1, total: 2 }], skipped: 0, total: 2 },
      },
      {
        name: '字段两侧空白要 trim',
        args: [[' A1 , 2 , 3.5 ']],
        expected: { items: [{ sku: 'A1', qty: 2, total: 7 }], skipped: 0, total: 7 },
      },
      {
        name: '折扣 1 合法（合计为 0）',
        args: [['A1,2,10,1']],
        expected: { items: [{ sku: 'A1', qty: 2, total: 0 }], skipped: 0, total: 0 },
      },
      {
        name: '列数过多视为非法行',
        args: [['A1,1,2,0,x']],
        expected: { items: [], skipped: 1, total: 0 },
      },
      { name: '空输入', args: [[]], expected: { items: [], skipped: 0, total: 0 } },
    ],
  },
  {
    /*
     * 扩题（第一组）：有状态实现 + 队列语义。
     *
     * 旧题面的被测函数都是一次调用出结果的纯函数；这一题的实现必须在内部维护
     * 可变状态（入队 / 出队 / 取消 / 改优先级），任何一步写错都会在后续操作里放大。
     * 同时把「同优先级先进先出」「改优先级不改变排队位置」这类语义写进隐藏集，
     * 只靠公开的两条操作序列无法覆盖。
     */
    id: 'job_queue',
    title: '任务队列（有状态实现）',
    implPath: 'eval/job_queue/impl.cjs',
    files: ['lib/queue.cjs'],
    exportName: 'runQueue',
    publicCases: [
      {
        name: '按优先级出队',
        args: [
          [
            { op: 'add', id: 'a', priority: 1 },
            { op: 'add', id: 'b', priority: 3 },
            { op: 'run' },
          ],
        ],
        expected: { done: ['b'], pending: [{ id: 'a', priority: 1 }] },
      },
      {
        name: '取消后不再执行',
        args: [
          [
            { op: 'add', id: 'a', priority: 1 },
            { op: 'add', id: 'b', priority: 2 },
            { op: 'cancel', id: 'b' },
            { op: 'run' },
          ],
        ],
        expected: { done: ['a'], pending: [] },
      },
    ],
    hiddenCases: [
      {
        name: '同优先级先入先出',
        args: [
          [
            { op: 'add', id: 'a', priority: 1 },
            { op: 'add', id: 'b', priority: 1 },
            { op: 'run' },
          ],
        ],
        expected: { done: ['a'], pending: [{ id: 'b', priority: 1 }] },
      },
      {
        name: '重复 add 只更新优先级，不重复入队',
        args: [
          [
            { op: 'add', id: 'a', priority: 1 },
            { op: 'add', id: 'b', priority: 1 },
            { op: 'add', id: 'a', priority: 5 },
            { op: 'run' },
            { op: 'run' },
            { op: 'run' },
          ],
        ],
        expected: { done: ['a', 'b'], pending: [] },
      },
      {
        name: '改优先级保留原排队位置',
        args: [
          [
            { op: 'add', id: 'a', priority: 1 },
            { op: 'add', id: 'b', priority: 2 },
            { op: 'add', id: 'a', priority: 2 },
            { op: 'run' },
            { op: 'run' },
          ],
        ],
        expected: { done: ['a', 'b'], pending: [] },
      },
      {
        name: '取消不存在的 id 被忽略',
        args: [
          [
            { op: 'add', id: 'a', priority: 1 },
            { op: 'cancel', id: 'x' },
            { op: 'run' },
          ],
        ],
        expected: { done: ['a'], pending: [] },
      },
      {
        name: '缺省优先级为 0',
        args: [
          [
            { op: 'add', id: 'a' },
            { op: 'add', id: 'b', priority: 1 },
            { op: 'run' },
          ],
        ],
        expected: { done: ['b'], pending: [{ id: 'a', priority: 0 }] },
      },
      {
        name: '取消后重新 add 排到队尾',
        args: [
          [
            { op: 'add', id: 'a', priority: 1 },
            { op: 'add', id: 'b', priority: 1 },
            { op: 'cancel', id: 'a' },
            { op: 'add', id: 'a', priority: 1 },
            { op: 'run' },
            { op: 'run' },
          ],
        ],
        expected: { done: ['b', 'a'], pending: [] },
      },
      {
        name: '未知 op 忽略',
        args: [
          [
            { op: 'add', id: 'a', priority: 1 },
            { op: 'nope' },
            { op: 'run' },
          ],
        ],
        expected: { done: ['a'], pending: [] },
      },
      { name: '空队列 run 无副作用', args: [[{ op: 'run' }]], expected: { done: [], pending: [] } },
      {
        name: 'pending 按下一个执行顺序排列',
        args: [
          [
            { op: 'add', id: 'a', priority: 1 },
            { op: 'add', id: 'b', priority: 3 },
            { op: 'add', id: 'c', priority: 2 },
          ],
        ],
        expected: {
          done: [],
          pending: [
            { id: 'b', priority: 3 },
            { id: 'c', priority: 2 },
            { id: 'a', priority: 1 },
          ],
        },
      },
      {
        name: '非法 id 与非整数优先级',
        args: [
          [
            { op: 'add', id: '', priority: 1 },
            { op: 'add', id: 'x', priority: 1.5 },
            { op: 'add', id: 'y', priority: 2 },
          ],
        ],
        expected: {
          done: [],
          pending: [
            { id: 'y', priority: 2 },
            { id: 'x', priority: 0 },
          ],
        },
      },
    ],
  },
  {
    /*
     * 扩题（第二组）：真实导入缺陷 —— CSV 引号 / 转义 / CRLF / 跨行字段。
     *
     * 旧题面的输入都是「已经结构化好的数据」（字符串、数组、操作序列），
     * Agent 只需要改计算逻辑。这一题给的是**原始文本**：缺陷在分词状态机里，
     * 天真的 split('\n') + split(',') 在公开样例上能过、在真实文件上必错。
     * 同时用「行号」把跨行字段和记录边界绑在一起 —— 解析逻辑写错，报错行号也会错。
     */
    id: 'csv_import',
    title: 'CSV 导入解析（引号与跨行字段）',
    implPath: 'eval/csv_import/impl.cjs',
    exportName: 'parseCsv',
    publicCases: [
      {
        name: '普通两行',
        args: ['a,b\nc,d'],
        expected: {
          rows: [
            ['a', 'b'],
            ['c', 'd'],
          ],
          errors: [],
        },
      },
      {
        name: '引号内的逗号',
        args: ['name,note\n"a,b",ok'],
        expected: {
          rows: [
            ['name', 'note'],
            ['a,b', 'ok'],
          ],
          errors: [],
        },
      },
    ],
    hiddenCases: [
      {
        name: 'CRLF 换行',
        args: ['a,b\r\nc,d'],
        expected: {
          rows: [
            ['a', 'b'],
            ['c', 'd'],
          ],
          errors: [],
        },
      },
      {
        name: '双引号转义',
        args: ['a,"say ""hi"""'],
        expected: { rows: [['a', 'say "hi"']], errors: [] },
      },
      {
        name: '引号内的换行属于字段',
        args: ['a,"line1\nline2"\nb,c'],
        expected: {
          rows: [
            ['a', 'line1\nline2'],
            ['b', 'c'],
          ],
          errors: [],
        },
      },
      {
        name: '剥离开头 BOM（后接引号字段）',
        args: ['\uFEFF"a",b\nc,d'],
        expected: {
          rows: [
            ['a', 'b'],
            ['c', 'd'],
          ],
          errors: [],
        },
      },
      {
        name: '只 trim 未引用字段',
        args: [' a ," b ",c '],
        expected: { rows: [['a', ' b ', 'c']], errors: [] },
      },
      {
        name: '列数不一致报错并跳过该行',
        args: ['a,b\nc\nb,d'],
        expected: {
          rows: [
            ['a', 'b'],
            ['b', 'd'],
          ],
          errors: [{ line: 2, message: '列数不一致（期望 2，实际 1）' }],
        },
      },
      {
        name: '引号未闭合',
        args: ['a,"b\nc,d'],
        expected: { rows: [], errors: [{ line: 1, message: '引号未闭合' }] },
      },
      {
        name: '引号闭合后出现多余字符',
        args: ['a,"b"x\nc,d'],
        expected: { rows: [['c', 'd']], errors: [{ line: 1, message: '引号闭合后出现多余字符' }] },
      },
      {
        name: '空行与纯空白行跳过',
        args: ['\n  \na,b\n\nc,d\n'],
        expected: {
          rows: [
            ['a', 'b'],
            ['c', 'd'],
          ],
          errors: [],
        },
      },
      {
        name: '报错行号要计入跨行字段',
        args: ['a,"x\ny"\nb\nc,d'],
        expected: {
          rows: [
            ['a', 'x\ny'],
            ['c', 'd'],
          ],
          errors: [{ line: 3, message: '列数不一致（期望 2，实际 1）' }],
        },
      },
      { name: '引号空字段', args: ['a,""'], expected: { rows: [['a', '']], errors: [] } },
      { name: '行尾多余逗号', args: ['a,b,'], expected: { rows: [['a', 'b', '']], errors: [] } },
      { name: '空输入', args: [''], expected: { rows: [], errors: [] } },
      {
        name: '引号内的 CRLF 归一为 LF',
        args: ['a,"x\r\ny"'],
        expected: { rows: [['a', 'x\ny']], errors: [] },
      },
      { name: '中间空字段', args: ['a,,c'], expected: { rows: [['a', '', 'c']], errors: [] } },
    ],
  },
  {
    id: 'json_patch',
    title: 'JSON 补丁应用（RFC 6901 指针 + 6902 子集）',
    implPath: 'eval/json_patch/impl.cjs',
    exportName: 'applyPatch',
    publicCases: [
      { name: '对象上新增成员', args: [{ a: 1 }, [{ op: 'add', path: '/b', value: 2 }]], expected: { a: 1, b: 2 } },
      { name: '删除数组元素', args: [{ list: [1, 2, 3] }, [{ op: 'remove', path: '/list/1' }]], expected: { list: [1, 3] } },
    ],
    hiddenCases: [
      {
        name: '~1 还原为斜杠',
        args: [{ 'a/b': 1 }, [{ op: 'replace', path: '/a~1b', value: 2 }]],
        expected: { 'a/b': 2 },
      },
      {
        name: '~0 还原为波浪号',
        args: [{ 'a~b': 1 }, [{ op: 'replace', path: '/a~0b', value: 2 }]],
        expected: { 'a~b': 2 },
      },
      {
        name: '非法转义必须报错',
        args: [{ a: 1 }, [{ op: 'replace', path: '/a~2b', value: 2 }]],
        throws: '非法路径转义',
      },
      {
        name: '数组下标处插入（不是追加）',
        args: [{ l: [1, 3] }, [{ op: 'add', path: '/l/1', value: 2 }]],
        expected: { l: [1, 2, 3] },
      },
      {
        name: 'add 用 - 追加到末尾',
        args: [{ l: [1] }, [{ op: 'add', path: '/l/-', value: 2 }]],
        expected: { l: [1, 2] },
      },
      {
        name: 'add 下标越界必须报错',
        args: [{ l: [1] }, [{ op: 'add', path: '/l/3', value: 2 }]],
        throws: '数组下标越界',
      },
      {
        name: 'remove 目标不存在必须报错',
        args: [{ a: 1 }, [{ op: 'remove', path: '/b' }]],
        throws: '路径不存在',
      },
      {
        name: 'remove 数组首元素',
        args: [{ l: ['x', 'y'] }, [{ op: 'remove', path: '/l/0' }]],
        expected: { l: ['y'] },
      },
      {
        name: 'replace 目标不存在必须报错',
        args: [{ a: 1 }, [{ op: 'replace', path: '/b', value: 2 }]],
        throws: '路径不存在',
      },
      {
        name: 'test 通过时原样返回',
        args: [{ a: { b: 1 } }, [{ op: 'test', path: '/a/b', value: 1 }]],
        expected: { a: { b: 1 } },
      },
      {
        name: 'test 不匹配必须报错',
        args: [{ a: { b: 1 } }, [{ op: 'test', path: '/a/b', value: 2 }]],
        throws: 'test 校验失败',
      },
      {
        name: '不支持的 op 必须报错',
        args: [{ a: 1 }, [{ op: 'move', from: '/a', path: '/b' }]],
        throws: '不支持的操作',
      },
      {
        name: '空指针替换整个文档',
        args: [{ a: 1 }, [{ op: 'replace', path: '', value: { b: 2 } }]],
        expected: { b: 2 },
      },
      {
        name: '嵌套数组里的对象字段',
        args: [{ a: { l: [{ v: 1 }] } }, [{ op: 'replace', path: '/a/l/0/v', value: 2 }]],
        expected: { a: { l: [{ v: 2 }] } },
      },
    ],
  },
  {
    /*
     * 扩题（第二组）：整数「分」记账 + 幂等流水 + 按日汇总/结息。
     *
     * 与前面几组的区别：旧题面的数值口径都是「显示层保留两位小数」，允许浮点在
     * 中间过程出现；这一题把金额固定为整数分，考的是「不合法的金额必须在入口被
     * 拒绝」而不是事后四舍五入。另一条轴是幂等：同一笔流水只能入账一次，且被拒
     * 的流水同样消耗流水号 —— 重放整批交易时不能重复扣款，也不能把拒绝当没发生。
     * 结息用 floor 到分，配 rateBps 的四条边界，专门抓 Math.round 这类近似实现。
     */
    id: 'bank_ledger',
    title: '银行分账台账（整数分记账 + 幂等流水）',
    implPath: 'eval/bank_ledger/impl.cjs',
    files: ['lib/ledger.cjs'],
    exportName: 'runLedger',
    publicCases: [
      {
        name: '基础存取',
        args: [
          [
            { op: 'deposit', txn: 't1', account: 'A', amount: 10000, date: '2026-01-02' },
            { op: 'withdraw', txn: 't2', account: 'A', amount: 2500, date: '2026-01-02' },
          ],
        ],
        expected: {
          balances: { A: 7500 },
          applied: ['t1', 't2'],
          rejected: [],
          days: [{ date: '2026-01-02', net: 7500, count: 2, interest: 0 }],
        },
      },
      {
        name: '余额不足拒绝且不留日记账',
        args: [
          [{ op: 'withdraw', txn: 't1', account: 'A', amount: 500, date: '2026-01-02' }],
        ],
        expected: {
          balances: {},
          applied: [],
          rejected: [{ txn: 't1', reason: '余额不足' }],
          days: [],
        },
      },
    ],
    hiddenCases: [
      {
        name: '重复流水号不重复入账',
        args: [
          [
            { op: 'deposit', txn: 't1', account: 'A', amount: 10000, date: '2026-01-02' },
            { op: 'deposit', txn: 't1', account: 'A', amount: 10000, date: '2026-01-02' },
          ],
        ],
        expected: {
          balances: { A: 10000 },
          applied: ['t1'],
          rejected: [{ txn: 't1', reason: '重复流水号' }],
          days: [{ date: '2026-01-02', net: 10000, count: 1, interest: 0 }],
        },
      },
      {
        name: '金额必须是正整数分',
        args: [
          [
            { op: 'deposit', txn: 't1', account: 'A', amount: 10.5, date: '2026-01-02' },
            { op: 'deposit', txn: 't2', account: 'A', amount: 0, date: '2026-01-02' },
            { op: 'deposit', txn: 't3', account: 'A', amount: -1, date: '2026-01-02' },
            { op: 'deposit', txn: 't4', account: 'A', amount: '100', date: '2026-01-02' },
          ],
        ],
        expected: {
          balances: {},
          applied: [],
          rejected: [
            { txn: 't1', reason: '金额非法' },
            { txn: 't2', reason: '金额非法' },
            { txn: 't3', reason: '金额非法' },
            { txn: 't4', reason: '金额非法' },
          ],
          days: [],
        },
      },
      {
        name: '转账双边记账、当日净额抵销',
        args: [
          [
            { op: 'deposit', txn: 't1', account: 'A', amount: 5000, date: '2026-01-02' },
            { op: 'transfer', txn: 't2', from: 'A', to: 'B', amount: 3000, date: '2026-01-02' },
          ],
        ],
        expected: {
          balances: { A: 2000, B: 3000 },
          applied: ['t1', 't2'],
          rejected: [],
          days: [{ date: '2026-01-02', net: 5000, count: 2, interest: 0 }],
        },
      },
      {
        name: '转账超额整笔拒绝',
        args: [
          [
            { op: 'deposit', txn: 't1', account: 'A', amount: 5000, date: '2026-01-02' },
            { op: 'transfer', txn: 't2', from: 'A', to: 'B', amount: 5001, date: '2026-01-02' },
          ],
        ],
        expected: {
          balances: { A: 5000 },
          applied: ['t1'],
          rejected: [{ txn: 't2', reason: '余额不足' }],
          days: [{ date: '2026-01-02', net: 5000, count: 1, interest: 0 }],
        },
      },
      {
        name: '转出转入相同被拒',
        args: [
          [
            { op: 'deposit', txn: 't1', account: 'A', amount: 5000, date: '2026-01-02' },
            { op: 'transfer', txn: 't2', from: 'A', to: 'A', amount: 100, date: '2026-01-02' },
          ],
        ],
        expected: {
          balances: { A: 5000 },
          applied: ['t1'],
          rejected: [{ txn: 't2', reason: '转出转入相同' }],
          days: [{ date: '2026-01-02', net: 5000, count: 1, interest: 0 }],
        },
      },
      {
        name: '结息向下取整到分',
        args: [
          [
            { op: 'deposit', txn: 't1', account: 'A', amount: 1999, date: '2026-01-02' },
            { op: 'settle', date: '2026-01-03', rateBps: 500 },
          ],
        ],
        expected: {
          balances: { A: 2098 },
          applied: ['t1'],
          rejected: [],
          days: [
            { date: '2026-01-02', net: 1999, count: 1, interest: 0 },
            { date: '2026-01-03', net: 99, count: 0, interest: 99 },
          ],
        },
      },
      {
        name: '结息利率必须是 0..10000 的整数',
        args: [
          [
            { op: 'deposit', txn: 't1', account: 'A', amount: 1000, date: '2026-01-02' },
            { op: 'settle', date: '2026-01-03', rateBps: -1 },
            { op: 'settle', date: '2026-01-03', rateBps: 1.5 },
            { op: 'settle', date: '2026-01-03', rateBps: 10001 },
          ],
        ],
        expected: {
          balances: { A: 1000 },
          applied: ['t1'],
          rejected: [
            { txn: '', reason: '利率非法' },
            { txn: '', reason: '利率非法' },
            { txn: '', reason: '利率非法' },
          ],
          days: [{ date: '2026-01-02', net: 1000, count: 1, interest: 0 }],
        },
      },
      {
        name: '零余额结息不产生日记账',
        args: [[{ op: 'settle', date: '2026-01-02', rateBps: 300 }]],
        expected: { balances: {}, applied: [], rejected: [], days: [] },
      },
      {
        name: '同一日期重复结息被拒',
        args: [
          [
            { op: 'deposit', txn: 't1', account: 'A', amount: 10000, date: '2026-01-02' },
            { op: 'settle', date: '2026-01-02', rateBps: 100 },
            { op: 'settle', date: '2026-01-02', rateBps: 100 },
          ],
        ],
        expected: {
          balances: { A: 10100 },
          applied: ['t1'],
          rejected: [{ txn: '', reason: '重复结息' }],
          days: [{ date: '2026-01-02', net: 10100, count: 1, interest: 100 }],
        },
      },
      {
        name: '按日汇总净额与笔数、日期升序',
        args: [
          [
            { op: 'deposit', txn: 't1', account: 'A', amount: 100, date: '2026-01-03' },
            { op: 'deposit', txn: 't2', account: 'A', amount: 100, date: '2026-01-01' },
            { op: 'withdraw', txn: 't3', account: 'A', amount: 40, date: '2026-01-01' },
            { op: 'deposit', txn: 't4', account: 'A', amount: 10, date: '2026-01-03' },
          ],
        ],
        expected: {
          balances: { A: 170 },
          applied: ['t1', 't2', 't3', 't4'],
          rejected: [],
          days: [
            { date: '2026-01-01', net: 60, count: 2, interest: 0 },
            { date: '2026-01-03', net: 110, count: 2, interest: 0 },
          ],
        },
      },
      {
        name: '日期必须是 YYYY-MM-DD',
        args: [
          [
            { op: 'deposit', txn: 't1', account: 'A', amount: 100, date: '2026/01/02' },
            { op: 'deposit', txn: 't2', account: 'A', amount: 100, date: '2026-1-2' },
            { op: 'deposit', txn: 't3', account: 'A', amount: 100, date: undefined },
          ],
        ],
        expected: {
          balances: {},
          applied: [],
          rejected: [
            { txn: 't1', reason: '日期非法' },
            { txn: 't2', reason: '日期非法' },
            { txn: 't3', reason: '日期非法' },
          ],
          days: [],
        },
      },
      {
        name: '流水号必须是非空字符串',
        args: [
          [
            { op: 'deposit', txn: undefined, account: 'A', amount: 100, date: '2026-01-02' },
            { op: 'deposit', txn: '', account: 'A', amount: 100, date: '2026-01-02' },
            { op: 'deposit', txn: 123, account: 'A', amount: 100, date: '2026-01-02' },
          ],
        ],
        expected: {
          balances: {},
          applied: [],
          rejected: [
            { txn: '', reason: '流水号非法' },
            { txn: '', reason: '流水号非法' },
            { txn: '', reason: '流水号非法' },
          ],
          days: [],
        },
      },
      {
        name: '账户必须是非空字符串',
        args: [
          [
            { op: 'deposit', txn: 't1', account: '', amount: 100, date: '2026-01-02' },
            { op: 'deposit', txn: 't2', account: 42, amount: 100, date: '2026-01-02' },
          ],
        ],
        expected: {
          balances: {},
          applied: [],
          rejected: [
            { txn: 't1', reason: '账户非法' },
            { txn: 't2', reason: '账户非法' },
          ],
          days: [],
        },
      },
      {
        name: '被拒交易同样消耗流水号',
        args: [
          [
            { op: 'withdraw', txn: 't1', account: 'A', amount: 500, date: '2026-01-02' },
            { op: 'deposit', txn: 't2', account: 'A', amount: 1000, date: '2026-01-02' },
            { op: 'withdraw', txn: 't1', account: 'A', amount: 500, date: '2026-01-02' },
          ],
        ],
        expected: {
          balances: { A: 1000 },
          applied: ['t2'],
          rejected: [
            { txn: 't1', reason: '余额不足' },
            { txn: 't1', reason: '重复流水号' },
          ],
          days: [{ date: '2026-01-02', net: 1000, count: 1, interest: 0 }],
        },
      },
    ],
  },
  {
    /*
     * 回归题：真实缺陷的复刻（全角冒号）。
     *
     * 来源是一次真实的自我修复：rsi-bridge 的 extractMetrics 用半角 `:` 匹配指标行，
     * 而内核 main.go 打印的是全角「：」(U+FF1A)，于是 metrics_json 恒为 null ——
     * 判据看着在跑，读数其实全是空的。这类缺陷的坏处是「不报错」：
     * 报告照常生成，只是每个指标都丢了。
     *
     * 放在电池里有两层意思：
     *  1) 它是「解析层必须两种冒号都认」的规格载体（历史报告两种都出现过）；
     *  2) 它是回归守卫 —— 谁把正则收窄回单一半角，这一格立刻变红。
     * 隐藏集专挑「尾巴」「多行混合」「指标名含点下划线」这些只看公开样例想不到的面。
     */
    id: 'rsi_report_parse',
    title: 'RSI 报告指标行解析（全角/半角冒号）',
    implPath: 'eval/rsi_report_parse/impl.cjs',
    exportName: 'parseMetricLines',
    publicCases: [
      {
        name: '全角冒号（真实报告格式）',
        args: ['  · task.test_pass_rate：0.6 → 1（变好=true）'],
        expected: [{ metric: 'task.test_pass_rate', before: 0.6, after: 1, better: true }],
      },
      {
        name: '半角冒号（历史报告格式）',
        args: ['  · tool.success_rate: 0.8 → 0.9（变好=true）'],
        expected: [{ metric: 'tool.success_rate', before: 0.8, after: 0.9, better: true }],
      },
      {
        name: '变好为 false',
        args: ['  · budget.efficiency：0.9 → 0.7（变好=false）'],
        expected: [{ metric: 'budget.efficiency', before: 0.9, after: 0.7, better: false }],
      },
      {
        name: '无指标行',
        args: ['判定：improved\n退出码：0（0=算数 1=不算数 2=拒收 3=核不了）'],
        expected: [],
      },
    ],
    hiddenCases: [
      {
        name: '护栏尾巴必须忽略',
        args: ['  · p95.latency：120 → 100（变好=true）（护栏：不得变差）'],
        expected: [{ metric: 'p95.latency', before: 120, after: 100, better: true }],
      },
      {
        name: '多行混合：两种冒号都要抓到',
        args: [
          '读数：上一代 3 条；这一代 3 条\n  · a.score：0.5 → 0.9（变好=true）\n  · b.score: 1 → 0.5（变好=false）\n判定：not_improved',
        ],
        expected: [
          { metric: 'a.score', before: 0.5, after: 0.9, better: true },
          { metric: 'b.score', before: 1, after: 0.5, better: false },
        ],
      },
      { name: '空报告', args: [''], expected: [] },
      {
        name: '指标名含点与下划线',
        args: ['  · l2.goal_term_coverage：0.4 → 0.8（变好=true）'],
        expected: [{ metric: 'l2.goal_term_coverage', before: 0.4, after: 0.8, better: true }],
      },
      { name: '非字符串入参', args: [null], expected: [] },
      {
        name: '整数与小数混合',
        args: ['  · rsi.chain_len：5 → 6（变好=true）'],
        expected: [{ metric: 'rsi.chain_len', before: 5, after: 6, better: true }],
      },
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
