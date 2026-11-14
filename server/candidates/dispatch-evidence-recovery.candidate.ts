/**
 * 判据 · 派单证据落盘回读（Judge / 尺子侧）
 *
 * ── 缺口现场（2026-11-14，code-search 第 1 次派单，逐字取证）──────────
 * 外层在 1380s 发 SIGTERM，但那一刀只打掉 shell：node 子进程又活了 10s，
 * 把完整 SSE 写进了 sse-code-search-1.txt。同一份现场的 run_report 自报：
 *
 *   outcome=budget_exhausted  statusCode=RUN_BUDGET_WALL_CLOCK
 *   reason=墙钟预算在第 9 步触发（1390044/1200000 ms）
 *   fileChangeCount=1  toolCallCount=11  durationMs=1390046
 *
 * 循环手里只有被掐断的 stdout，于是连锁三处误判：
 *   1. 「本轮没有 run_report」→ 归因 DISPATCH_TIMEOUT_NO_REPORT / retry_same。
 *      真实原因是服务端墙钟天花板 → 正确动作是 raise_budget + 停机调预算。
 *      代价可量化：归因错了，同一道题又白烧一轮 23 分钟。
 *   2. 围栏在**移动靶**上判哈希：它在 06:43:0x 读盘，Agent 在 06:43:07.569
 *      才写入，于是判「靶子未被改动（本次改动 = 无）」——而磁盘上那个文件
 *      明明变了（235910cc… → d23e7028…）。
 *   3. 第二次派单又把上一轮的迟到写入算成自己的改动（同一次派单里
 *      PASS 目标文件被改动），账目串轮。
 *
 * ── 判据钉什么 ────────────────────────────────────────────
 * 「证据落到盘上就以盘为准，并且要等它静止。」等的位置在围栏之前，
 * 所以围栏天然不再判移动靶。B 块是判别力核心：
 * 同一份真 SSE，走盘上 → 墙钟天花板；只给被掐断的 stdout → NO_REPORT。
 * 两条必须给出不同结论，否则这条修复等于没修。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { attributeFailure, type AttributionInput } from '../../scripts/failure-attribution.js';
import { readSseDump, waitForSseDump } from '../../scripts/lib/dispatch-evidence.mjs';
import { DISPATCH_HEADROOM_MS } from '../../scripts/lib/dispatch-timeout.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..', '..');

const cleanups: Array<() => void> = [];
let dir = '';
const freshDir = (): string => {
  if (!dir) {
    dir = mkdtempSync(path.join(tmpdir(), 'cl-evidence-'));
    cleanups.push(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 宿主的删除守卫在并发下可能超时；清理是 best-effort，不影响结论。
      }
    });
  }
  return dir;
};
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  dir = '';
});

/** 真实 SSE 尾部（sse-code-search-1.txt 逐字）：meta 带 maxIterations，run_report 带墙钟真值。 */
const REAL_SSE = [
  'event: meta',
  'data: {"sessionId":"bb84fc7e-cb88-41ea-b42b-cf5e1c5aa0b5","messageId":"c20c508d-e17e-4ea6-88f3-044f85d1272e","provider":"custom","model":"nvidia/nemotron-3-ultra-550b-a55b","channel":"native","degraded":false,"degradedReason":null,"iteration":1,"maxIterations":25,"contextWindow":128000,"tokenBudget":768000,"estimatedPromptTokens":0,"toolCount":19,"switchedFrom":null,"switchReason":null}',
  '',
  'event: run_report',
  'data: {"runId":"4b397785-c8b0-4f2e-9f68-8c3e017053cd","sessionId":"bb84fc7e-cb88-41ea-b42b-cf5e1c5aa0b5","outcome":"budget_exhausted","statusCode":"RUN_BUDGET_WALL_CLOCK","reason":"墙钟预算在第 9 步触发（1390044/1200000 ms）；已做：已完成 11 次工具调用、改动 1 个文件；未做：后续轮次因墙钟上限未执行","notDone":["后续轮次因墙钟上限未执行"],"hasMaterialChange":true,"triggers":["文件改动","成本超阈值","预算耗尽"],"finishReason":"budget_exhausted","fileChangeCount":1,"irreversibleCount":0,"approvalCount":0,"errorCount":0,"toolCallCount":11,"promptTokens":134603,"completionTokens":6261,"durationMs":1390046,"summary":"改动 1 个文件（1 次写入）；工具调用 11 次；耗时 1390.0s；token 140864（复核 0）"}',
  '',
  'event: done',
  'data: {"finishReason":"budget_exhausted","iteration":9,"toolCallCount":11,"usage":{"promptTokens":134603,"completionTokens":6261},"tokenBudget":768000,"messageId":"","firstTokenMs":58528}',
  '',
].join('\n');

/** 被掐断的 stdout 原样：只有掐断标记，没有 run_report。 */
const KILLED_STDOUT =
  '  ▶ 派单给 Agent（题目 code-search，允许改 src/tools/builtin/code-search.tool.ts）\n' +
  '  ! DISPATCH_TIMEOUT=1380000ms kill=SIGTERM\n';

const base: AttributionInput = {
  taskId: 'evidence-probe',
  attempt: 1,
  maxAttempts: 3,
  dispatch: { exitOk: false, output: KILLED_STDOUT },
  diagnosis: '',
  fence: {
    reached: true,
    targetChanged: true,
    typeOk: true,
    judgeOk: true,
    fullOk: false,
    fullRan: true,
    protectedIntact: true,
    judgeTampered: false,
  },
  serviceHealthy: true,
};
const withOutput = (output: string, exitOk = false): AttributionInput => ({
  ...base,
  dispatch: { exitOk, output },
});

// ─────────────────────────────────────────────────────────────────────────────
describe('A · 落盘回读', () => {
  it('盘上有证据就读得到，且逐字', () => {
    const file = path.join(freshDir(), 'sse-t1.txt');
    writeFileSync(file, REAL_SSE, 'utf8');
    expect(readSseDump(file)).toBe(REAL_SSE);
  });

  it('文件不存在 → 空串，不抛', () => {
    const file = path.join(freshDir(), 'nope.txt');
    expect(readSseDump(file)).toBe('');
    expect(() => readSseDump(file)).not.toThrow();
  });

  it('路径是目录 → 空串，不抛（读目录会 EISDIR）', () => {
    const asDir = path.join(freshDir(), 'sse-dir.txt');
    mkdirSync(asDir);
    expect(readSseDump(asDir)).toBeFalsy();
  });

  it('等待：证据早就在盘上时立刻返回，不白等一个轮询', async () => {
    const file = path.join(freshDir(), 'sse-t2.txt');
    writeFileSync(file, REAL_SSE, 'utf8');
    const t0 = Date.now();
    const got = await waitForSseDump(file, 5_000);
    expect(got).toBe(REAL_SSE);
    // 上限 5s 却真的等了 5s，说明判断条件写错了（等成了定长睡眠）。
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('等待：证据晚到就等它，不把「还没落盘」当成「没有证据」', async () => {
    const file = path.join(freshDir(), 'sse-t3.txt');
    const timer = setTimeout(() => writeFileSync(file, REAL_SSE, 'utf8'), 300);
    const got = await waitForSseDump(file, 5_000);
    clearTimeout(timer);
    expect(got).toBe(REAL_SSE);
  });

  it('等待：证据始终不来 → 到上限返回空串，不无限等', async () => {
    const file = path.join(freshDir(), 'never.txt');
    const t0 = Date.now();
    const got = await waitForSseDump(file, 900);
    const spent = Date.now() - t0;
    expect(got).toBe('');
    expect(spent).toBeGreaterThanOrEqual(800);
    // 允许一个轮询 + 调度抖动的过冲，但不能是「上限根本没生效」。
    expect(spent).toBeLessThan(3_000);
  });

  it('空文件不算证据：空串继续等，等到真内容才收手', async () => {
    const file = path.join(freshDir(), 'sse-t4.txt');
    writeFileSync(file, '', 'utf8');
    const timer = setTimeout(() => writeFileSync(file, REAL_SSE, 'utf8'), 300);
    const got = await waitForSseDump(file, 5_000);
    clearTimeout(timer);
    expect(got).toBe(REAL_SSE);
  });
});

const writeReal = (d: string, name: string): string => {
  const file = path.join(d, name);
  writeFileSync(file, REAL_SSE, 'utf8');
  return file;
};


// ─────────────────────────────────────────────────────────────────────────────
describe('B · 判别力：同一份现场，盘上证据必须改变结论', () => {
  it('只给被掐断的 stdout → NO_REPORT / retry_same（对照：修复前的行为）', () => {
    const a = attributeFailure(withOutput(KILLED_STDOUT));
    expect(a.code).toBe('DISPATCH_TIMEOUT_NO_REPORT');
    expect(a.nextAction).toBe('retry_same');
  });

  it('同一份现场从盘上取 → 墙钟天花板 / raise_budget / 不计入 Agent', () => {
    const a = attributeFailure(withOutput(REAL_SSE));
    expect(a.code).toBe('WALL_CLOCK_CEILING');
    expect(a.nextAction).toBe('raise_budget');
    expect(a.countsAgainstAgent).toBe(false);
    expect(a.note).toContain('AGENT_TASK_BUDGET_MS');
    expect(a.evidence.join(' ')).toContain('1390044/1200000 ms');
    // 归因若还停在 NO_REPORT，这一整条修复就是空转。
    expect(a.code).not.toBe('DISPATCH_TIMEOUT_NO_REPORT');
  });

  it('盘上证据优先：stdout 说没报告、盘上有报告时，结论按盘上来', () => {
    const disk = readSseDump(writeReal(freshDir(), 'prefer.txt'));
    const evidence = disk || KILLED_STDOUT;
    expect(evidence).toBe(REAL_SSE);
    const a = attributeFailure(withOutput(evidence));
    expect(a.code).toBe('WALL_CLOCK_CEILING');
  });

  it('盘上什么都没有时回退 stdout，结论与今天一致（向后兼容）', () => {
    const disk = readSseDump(path.join(freshDir(), 'absent.txt'));
    const evidence = disk || KILLED_STDOUT;
    expect(evidence).toBe(KILLED_STDOUT);
    expect(attributeFailure(withOutput(evidence)).code).toBe('DISPATCH_TIMEOUT_NO_REPORT');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
describe('C · 接线（机械）：循环必须真的用上盘上证据', () => {
  const loopSrc = (): string =>
    readFileSync(path.join(serverRoot, 'scripts', 'self-upgrade-loop.ts'), 'utf8');

  it('异常退出时等证据静止，正常退出时只同步读一次', () => {
    const src = loopSrc();
    // 这一行的语义就是本判据的题眼：掐断与否决定要不要等。
    expect(src.includes('await waitForSseDump(sseDump')).toBe(true);
    expect(/sent\.ok\s*\?\s*readSseDump\(sseDump\)\s*:\s*await\s+waitForSseDump\(sseDump/.test(src)).toBe(true);
    // 盘上证据必须真的参与取值：只声明 diskEvidence 却回退成 sent.out，
    // 等于整条修复空转（下面 B 块的单测抓不到这种，接线断言才抓得到）。
    expect(/const evidence = diskEvidence \|\| sent\.out;/.test(src)).toBe(true);
  });

  it('等待上限与外层余量共用同一个常量，不许各写一个数', () => {
    const src = loopSrc();
    expect(/waitForSseDump\(sseDump,\s*DISPATCH_HEADROOM_MS\)/.test(src)).toBe(true);
  });

  it('证据来源必须换成 evidence：工具调用计数不许再吃被掐断的 stdout', () => {
    const src = loopSrc();
    expect(src.includes('readToolCallEvidence(evidence)')).toBe(true);
    expect(src.includes('readToolCallEvidence(sent.out)')).toBe(false);
  });

  it('归因输入必须是 evidence：否则盘上报告也救不回归因', () => {
    const src = loopSrc();
    expect(/dispatch:\s*\{\s*exitOk:\s*sent\.ok,\s*output:\s*evidence\s*\}/.test(src)).toBe(true);
    expect(src.includes('output: sent.out')).toBe(false);
  });

  it('掐断标记的那几行仍从 stdout 打印（人看得见），别把可见性一起删了', () => {
    expect(loopSrc().includes('sent.out.split')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('D · 余量口径', () => {
  it('取证等待上限 = 外层过冲余量（同一个概念只许有一个数）', () => {
    // 180s 余量撞上 190s 单轮过冲，差 10 秒丢掉全部证据——这就是没有余量的样子。
    expect(DISPATCH_HEADROOM_MS).toBeGreaterThanOrEqual(300_000);
    expect(DISPATCH_HEADROOM_MS).toBeLessThanOrEqual(600_000);
  });
});