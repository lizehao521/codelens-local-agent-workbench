/**
 * 判据三态分类必须认得 vitest 的真实输出——带 ANSI 颜色码的那种。
 *
 * 缺陷现场（fs-read-line-window 派单第 2/3 轮，机械取证）：
 * 围栏用 execFileSync(stdio:'pipe') 跑 vitest，vitest 仍然吐颜色码。汇总行长这样：
 *   "      Tests \u001b[22m \u001b[1m\u001b[31m3 failed\u001b[39m…"
 * 而 classifyJudgeRun 的 /Tests\s+(\d+)\s+failed/ 要求 "Tests" 与数字之间只有空白，
 * 中间夹着转义序列就匹配不上 → failed=0 passed=0 → ran=false → 判成 unexec。
 * 于是**每一次「跑了没过」都被报成「尺子没跑起来」**，正好抹掉了这个分类器
 * 存在的全部理由。既有判据 tests/scripts/unexec-consumption.test.ts 用的全是
 * 干净文本夹具，所以一路绿着漏掉了它。
 *
 * 本份夹具全部是实跑 vitest 捕获的原始字节（见 /tmp 捕获记录），不是手编的。
 * 反向金丝雀同样重要：剥色之后不能把「真的没跑」洗成「跑了没过」——
 * 真实的模块加载失败输出里也有 "Test Files 1 failed"，松散匹配会把它误判成 ran。
 */
import { describe, expect, it } from 'vitest';
import { classifyJudgeRun, failedFilesOf, regressionRunEvidence } from '../../scripts/lib/judge-run-classify.mjs';

const E = '\u001b';

/** 实跑捕获：tests/self-upgrade/fs-read-line-window.test.ts，3 failed | 18 passed。 */
const REAL_FILES_FAIL = `${E}[2m Test Files ${E}[22m ${E}[1m${E}[31m1 failed${E}[39m${E}[22m${E}[90m (1)${E}[39m`;
const REAL_TESTS_FAIL = `${E}[2m      Tests ${E}[22m ${E}[1m${E}[31m3 failed${E}[39m${E}[22m${E}[2m | ${E}[22m${E}[1m${E}[32m18 passed${E}[39m${E}[22m${E}[90m (21)${E}[39m`;
const REAL_BANNER = `${E}[31m⎯⎯⎯⎯⎯⎯⎯${E}[39m${E}[1m${E}[41m Failed Tests 3 ${E}[49m${E}[22m${E}[31m⎯⎯⎯⎯⎯⎯⎯${E}[39m`;
const REAL_ASSERT = `AssertionError: expected true to be false // Object.is equality`;
const REAL_FAIL_OUT = `${REAL_FILES_FAIL}\n${REAL_TESTS_FAIL}\n\n${REAL_BANNER}\n${REAL_ASSERT}\n`;
/** 实跑捕获：带色的 FAIL 行，路径后面还跟着用例名。 */
const REAL_FAIL_LINE = `${E}[41m${E}[1m FAIL ${E}[22m${E}[49m tests/self-upgrade/fs-read-line-window.test.ts${E}[2m > ${E}[22m越界与入参${E}[2m > ${E}[22m越界消息不得谎报被截断后的行数`;

/** 实跑捕获：tests/self-upgrade/code-search-glob.test.ts，模块不存在，真的没跑。 */
const REAL_TESTS_UNEXEC = `${E}[2m      Tests ${E}[22m ${E}[2mno tests${E}[22m`;
const REAL_LOAD_ERR = `${E}[31m${E}[1mError${E}[22m: Cannot find module '../../src/tools/builtin/code-search.tool.js' imported from server/tests/self-upgrade/code-search-glob.test.ts${E}[39m`;
const REAL_UNEXEC_OUT = `${REAL_FILES_FAIL}\n${REAL_TESTS_UNEXEC}\n${REAL_LOAD_ERR}\n`;

describe('缺陷复现：带 ANSI 的真实失败输出必须判成 fail', () => {
  it('实跑捕获的 3 failed | 18 passed → ran=true', () => {
    expect(classifyJudgeRun(REAL_FAIL_OUT, false).ran).toBe(true);
  });

  it('实跑捕获的失败输出不得判成 unexec', () => {
    expect(classifyJudgeRun(REAL_FAIL_OUT, false).status === 'unexec').toBe(false);
  });

  it('只有汇总行（无 Test Files / 无 banner）也要认出来', () => {
    expect(classifyJudgeRun(REAL_TESTS_FAIL, false).status).toBe('fail');
  });

  it('只有颜色码没有 dim 码的写法同样要认（不同 TERM / vitest 版本）', () => {
    const out = `      Tests  ${E}[31m2 failed${E}[39m | ${E}[32m5 passed${E}[39m (7)`;
    expect(classifyJudgeRun(out, false).ran).toBe(true);
  });

  it('全失败无 passed 段 + ANSI → fail', () => {
    const out = `${E}[2m      Tests ${E}[22m ${E}[1m${E}[31m3 failed${E}[39m${E}[22m${E}[90m (3)${E}[39m`;
    expect(classifyJudgeRun(out, false).status).toBe('fail');
  });

  it('CRLF 行尾 + ANSI（Windows 检出）→ fail', () => {
    expect(classifyJudgeRun(REAL_FAIL_OUT.replace(/\n/g, '\r\n'), false).ran).toBe(true);
  });
});

describe('反向金丝雀：剥色不得把「真的没跑」洗成「跑了没过」', () => {
  it('实跑捕获的模块加载失败 → ran=false', () => {
    expect(classifyJudgeRun(REAL_UNEXEC_OUT, false).ran).toBe(false);
  });

  it('同一份输出里有 "Test Files 1 failed"，不得据此认定跑过', () => {
    expect(classifyJudgeRun(REAL_UNEXEC_OUT, false).status === 'fail').toBe(false);
  });

  it('no tests + ANSI → unexec', () => {
    expect(classifyJudgeRun(REAL_TESTS_UNEXEC, false).status).toBe('unexec');
  });

  it('0 passed 0 failed + ANSI → unexec（零用例不算跑过）', () => {
    const out = `${E}[2m      Tests ${E}[22m ${E}[2m0 passed${E}[22m${E}[90m (0)${E}[39m`;
    expect(classifyJudgeRun(out, false).ran).toBe(false);
  });

  it('只有颜色码、没有任何计数 → unexec（剥色不许凭空造出数字）', () => {
    const out = `${E}[31mTests${E}[39m ${E}[2mno tests${E}[22m`;
    expect(classifyJudgeRun(out, false).ran).toBe(false);
  });

  it('纯转义序列噪声 → unexec', () => {
    expect(classifyJudgeRun(`${E}[31m${E}[1m${E}[39m${E}[22m`, false).ran).toBe(false);
  });

  it('空输出与 undefined 仍是 unexec', () => {
    expect(classifyJudgeRun('', false).ran).toBe(false);
    expect(classifyJudgeRun(undefined, false).ran).toBe(false);
  });
});

describe('回归：干净文本与退出码语义不变', () => {
  it('退出码 0 → pass，且优先于任何文本解析', () => {
    expect(classifyJudgeRun(REAL_UNEXEC_OUT, true)).toEqual({ status: 'pass', ran: true });
  });

  it('干净文本的失败汇总仍判 fail', () => {
    const out = 'Test Files  1 failed (1)\n     Tests  2 failed | 5 passed (7)';
    expect(classifyJudgeRun(out, false)).toEqual({ status: 'fail', ran: true });
  });

  it('干净文本的加载失败仍判 unexec', () => {
    const out = 'Test Files  1 failed (1)\nError: Failed to load url ./judge.ts';
    expect(classifyJudgeRun(out, false).ran).toBe(false);
  });

  it('编译错仍判 unexec', () => {
    expect(classifyJudgeRun('SyntaxError: Unexpected token', false).status).toBe('unexec');
  });
});

/**
 * 同一处 ANSI 失明的第三个消费者：围栏的「首次红 → 只串行复跑失败文件」。
 *
 * 实跑取证：failedFilesOf 的 /(?:FAIL|❯)\s+(…\.test\.ts)/ 在带色输出上返回 []，
 * 因为真实行是 "\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m tests/…"。
 * 于是 files.length===0，围栏走进 else 分支**整轮并发重跑**，
 * 通过后却打印「首次红在串行复跑中转绿 → 判为并发假红」——
 * 它宣称的方法根本没执行过。定向串行复跑在本机是死代码。
 */
describe('失败文件提取：定向串行复跑不能因为颜色码而失效', () => {
  it('带色的 FAIL 行要能提出文件路径', () => {
    expect(failedFilesOf(`${REAL_FAIL_LINE}\n${REAL_FAIL_OUT}`)).toEqual([
      'tests/self-upgrade/fs-read-line-window.test.ts',
    ]);
  });

  it('提不出文件就会退化成整轮重跑 —— 不许为空', () => {
    expect(failedFilesOf(`${REAL_FAIL_LINE}\n${REAL_FAIL_OUT}`).length === 0).toBe(false);
  });

  it('同一文件多条 FAIL 只算一个', () => {
    expect(failedFilesOf(`${REAL_FAIL_LINE}\n${REAL_FAIL_LINE}`)).toHaveLength(1);
  });

  it('多个文件都要提出来（上限 8 个才走定向复跑）', () => {
    const two = `${REAL_FAIL_LINE}\n${E}[41m FAIL ${E}[49m tests/scripts/unexec-consumption.test.ts > x`;
    expect(failedFilesOf(two)).toHaveLength(2);
  });

  it('❯ 前缀的带色行同样要认', () => {
    const out = `${E}[36m ${E}[2m❯${E}[22m tests/self-upgrade/judge-run-ansi.test.ts:${E}[2m12:3${E}[22m`;
    expect(failedFilesOf(out)).toEqual(['tests/self-upgrade/judge-run-ansi.test.ts']);
  });

  it('干净文本行为不变', () => {
    const out = ' FAIL  tests/a.test.ts > x\n ❯ tests/b.test.ts:3:1';
    expect(failedFilesOf(out)).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
  });

  it('Windows 反斜杠路径归一成正斜杠', () => {
    expect(failedFilesOf(' FAIL  tests\\scripts\\unexec-consumption.test.ts > x')).toEqual([
      'tests/scripts/unexec-consumption.test.ts',
    ]);
  });

  it('没有失败行时返回空（真的没红，不该触发复跑）', () => {
    expect(failedFilesOf(`${E}[2m Test Files ${E}[22m 1 passed (1)`)).toEqual([]);
  });

  it('非 tests/ 下的路径不收（复跑目标必须是判据）', () => {
    expect(failedFilesOf(' FAIL  src/whatever.test.ts > x')).toEqual([]);
  });
});

/**
 * 第三组：判 FAIL 必须留得下证据。
 *
 * 现场：fs-read-line-window 第二次派单，三轮围栏都打印
 * 「全量回归红了且串行复跑仍红 —— 可复现，判为真回归」，
 * 而 diag 文件里只有这一句结论，零个失败用例名；人工直跑同一份全量套件
 * 却是 169 文件 / 1687 passed / exit 0。execFileSync 超时被杀时 e.stdout 可能为空，
 * 那是取证缺失，不是「可复现」。缺证据不许下可复现结论（C4）。
 */
describe('回归取证：空输出不是「可复现」', () => {
  it('真实带色失败输出 → 有证据、有文件、有摘要行', () => {
    const e = regressionRunEvidence(`${REAL_FAIL_LINE}\n${REAL_FAIL_OUT}`, { status: 1 });
    expect(e.hasEvidence).toBe(true);
    expect(e.files).toEqual(['tests/self-upgrade/fs-read-line-window.test.ts']);
    expect(e.lines.length).toBeGreaterThan(0);
  });

  it('带色的 Tests 汇总行必须进摘要（不剥色就一条都留不下）', () => {
    const e = regressionRunEvidence(REAL_FAIL_OUT, { status: 1 });
    expect(e.lines.some((l) => /Tests\s+\d/.test(l))).toBe(true);
  });

  it('超时被杀且无输出 → 取证缺失', () => {
    expect(regressionRunEvidence('', { signal: 'SIGTERM' }).hasEvidence).toBe(false);
  });

  it('超时被杀要标出来，不能混同于用例失败', () => {
    expect(regressionRunEvidence('', { signal: 'SIGTERM' }).timedOut).toBe(true);
  });

  it('ETIMEDOUT 同样算超时', () => {
    expect(regressionRunEvidence(null, { code: 'ETIMEDOUT' }).timedOut).toBe(true);
  });

  it('普通非零退出不是超时', () => {
    expect(regressionRunEvidence(REAL_FAIL_OUT, { status: 1 }).timedOut).toBe(false);
  });

  it('空输出时不得凭空给出失败文件', () => {
    expect(regressionRunEvidence('', { signal: 'SIGTERM' }).files).toEqual([]);
  });

  it('只有空白字符也算取证缺失', () => {
    expect(regressionRunEvidence('  \n\t \n', { status: 1 }).hasEvidence).toBe(false);
  });

  it('undefined 输出不炸', () => {
    expect(regressionRunEvidence(undefined, undefined).hasEvidence).toBe(false);
  });

  it('通过的输出没有失败文件（不该触发复跑）', () => {
    const e = regressionRunEvidence(`${E}[2m Test Files ${E}[22m 169 passed (169)`, undefined);
    expect(e.files).toEqual([]);
  });
});