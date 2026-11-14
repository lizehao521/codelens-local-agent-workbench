/**
 * dispatch-evidence.mjs — 派单证据的落盘回读。
 *
 * ── 现场（2026-11-14，code-search 第 1 次派单，机械取证）──────────────
 * 外层在 1380s 发 SIGTERM，但那一刀只打掉 shell —— node 子进程又活了 10s
 * （run_report 自报 durationMs=1390046），把完整 SSE 写进了
 * sse-code-search-1.txt。循环手里只有被掐断的 stdout，于是连锁三处误判：
 *
 *   1. stdout 里没有 run_report → 归因记成 DISPATCH_TIMEOUT_NO_REPORT /
 *      retry_same。真实原因是服务端墙钟天花板（statusCode=RUN_BUDGET_WALL_CLOCK，
 *      1390044/1200000 ms）→ 正确动作是 raise_budget + 停机调预算。
 *      代价可量化：错误归因让同一道题又白烧一轮 23 分钟。
 *   2. 围栏紧接着在**移动靶**上判哈希 —— 它在 06:43:0x 读盘，Agent 在
 *      06:43:07.569 才写入，于是判出「靶子未被改动（本次改动 = 无）」，
 *      而磁盘上那个文件明明变了（235910cc… → d23e7028…）。
 *   3. 下一轮又把这笔迟到的写入算成自己的改动（同一次派单里
 *      PASS 目标文件被改动），账目串轮。
 *
 * 一个修法同时治三处：**证据落到盘上就以盘为准，并且要等它静止。**
 * 等的位置在围栏之前，所以围栏天然不会再判移动靶。
 *
 * ── 为什么「文件存在」就等于「证据完整」──────────────────────
 * task-self-upgrade.ts 是一次 writeFileSync(dump, sse) 整块落盘，
 * 不存在写一半的中间态。所以判定条件不是大小稳定，而是文件出现。
 *
 * ── 为什么等待上限跟外层余量共用 ───────────────────────────
 * 外层超时 = 服务端墙钟 + 余量（lib/dispatch-timeout.mjs），余量就是
 * 「预算触发后还允许多跑多久」。掐断之后子进程最多再活这么久，所以
 * 取证等待也用同一个数：两个数各写一份就会漂移（本轮就是 180s 余量
 * 撞上 190s 单轮过冲，差 10 秒丢掉全部证据）。
 */

import { existsSync, readFileSync } from 'node:fs';

/** 轮询间隔：证据通常在一次心跳内落盘，1s 足够细，且不会把停机时间拉长。 */
export const EVIDENCE_POLL_MS = 1_000;

/**
 * 同步读一次盘上的 SSE。读不到（不存在 / 是目录 / 权限）一律返回空串：
 * 取证失败不该把整个循环打挂，调用方会回退到 stdout。
 */
export function readSseDump(file) {
  try {
    if (!existsSync(file)) return '';
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 等盘上 SSE 出现，最多等 capMs，返回其内容；超时返回空串（不回退 stdout，
 * 让调用方自己决定）。
 *
 * 只在**异常退出**时调用：正常退出时文件早就在盘上，同步读一次即可，
 * 不该为一个已经完整的证据额外付一次轮询。
 */
export async function waitForSseDump(file, capMs, pollMs = EVIDENCE_POLL_MS) {
  const deadline = Date.now() + capMs;
  for (;;) {
    const text = readSseDump(file);
    if (text) return text;
    if (Date.now() >= deadline) return '';
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}