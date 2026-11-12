/**
 * rate-limit.ts — 出网 LLM 调用的统一限速（滑动窗口，每分钟 N 次）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────
 * NVIDIA / 各 OpenAI 兼容端点都有「每分钟请求数（RPM）」上限。之前 self-upgrade
 * 循环在 propose 阶段会拉起一个长 agent 轮（多轮工具调用 = 多请求），
 * 加上 author 步骤的并发，很容易在某一分钟内打到 429。429 一旦触发，
 * 整轮派单拿到空 run_report，又被归因记成 Agent 的实现层失败 —— 又一次
 * 环境/协议问题伪装成能力问题。
 *
 * ── 设计 ───────────────────────────────────────────────────
 * · 按 host 独立计数（不同上游互不影响）。
 * · 滑动窗口：窗口长度 60s，窗口内请求数 ≥ LIMIT 就等到最旧那条滑出窗口。
 * · **跨进程共享**：self-upgrade 循环里 propose 跑在 loop-service 子进程，
 *   author 跑在另一个进程，二者是独立进程。单进程内存计数会让两个进程各算各的，
 *   实际上限翻倍、照样触发 429。所以用「锁目录 + 时间戳文件」落盘共享。
 * · 锁目录用 mkdir 原子创建（POSIX/NTFS 都原子），避免两个进程同时改写状态。
 *
 * ── 默认 ──────────────────────────────────────────────────
 * 40 次/分钟（RSI_API_RPM 可配）。这就是用户要求的「每分钟 40」。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const LIMIT = Math.max(1, Number(process.env.RSI_API_RPM ?? 40));
const WINDOW_MS = 60_000;
/** 取到窗口边界后再多等一点，避免边界抖动导致「刚好还是 40」。 */
const MARGIN_MS = 25;
/** 锁目录里放一个时间戳文件；超过这个年龄的锁视为残留（崩溃遗留），直接抢断。 */
const STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 30_000;

const STATE_DIR = process.env.RSI_RATE_DIR ?? join(os.tmpdir(), 'rsi-ratelimit');
try {
  mkdirSync(STATE_DIR, { recursive: true });
} catch {
  /* 目录建不成也会在每次读写时重试；最坏情况退化为「不限速」而非卡死 */
}

/** 把 host 名洗成合法文件名。 */
function hostKey(host: string): string {
  return host.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'default';
}
function statePath(host: string): string {
  return join(STATE_DIR, `${hostKey(host)}.json`);
}
/** 用目录当互斥锁：mkdir 在 NTFS/APFS/ext4 上都是原子的。 */
function lockPath(host: string): string {
  return `${statePath(host)}.lock`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 纯函数：给定窗口内已有请求的时间戳，返回需要等待的毫秒数。-1 表示立即可发。 */
export function computeRateWait(timestamps: number[], now: number, limit: number, windowMs: number): number {
  const fresh = timestamps.filter((t) => now - t < windowMs);
  if (fresh.length < limit) return -1;
  const oldest = Math.min(...fresh);
  return windowMs - (now - oldest) + MARGIN_MS;
}

function readTs(host: string): number[] {
  try {
    const arr = JSON.parse(readFileSync(statePath(host), 'utf8')) as unknown;
    return Array.isArray(arr) ? (arr as number[]).filter((n) => typeof n === 'number') : [];
  } catch {
    return [];
  }
}
function writeTs(host: string, ts: number[]): void {
  try {
    writeFileSync(statePath(host), JSON.stringify(ts.slice(-LIMIT)), 'utf8');
  } catch {
    /* 写入失败不致命：本次不计数，最坏退化成「这次没限速」 */
  }
}

/**
 * 在锁内执行 fn，确保同一 host 同一时刻只有一个调用方在改状态。
 * 锁用目录表示；若拿到锁的进程崩溃，锁目录会残留，按 STALE_MS 抢断重来。
 */
async function withLock<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const lock = lockPath(host);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lock, { recursive: false });
      break;
    } catch {
      // 锁被占用：先看是不是残留。
      try {
        if (existsSync(join(lock, 't'))) {
          const age = Date.now() - Number(readFileSync(join(lock, 't'), 'utf8') || 0);
          if (age > STALE_MS) {
            rmSync(lock, { recursive: true, force: true });
            continue;
          }
        }
      } catch {
        /* 读不到时间就按「活着」处理 */
      }
      if (Date.now() > deadline) throw new Error(`rate-limit 锁超时（host=${host}）`);
      await sleep(20);
    }
  }
  try {
    try {
      writeFileSync(join(lock, 't'), String(Date.now()), 'utf8');
    } catch {
      /* 时间写不上不影响互斥 */
    }
    return await fn();
  } finally {
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      /* 残留锁会在 STALE_MS 后被下一个调用方抢断 */
    }
  }
}

/** 单次取号：在锁内决定「立刻发」还是「要等多久」。返回等待毫秒（-1=立即）。 */
async function acquireOnce(host: string): Promise<number> {
  return withLock(host, async () => {
    const now = Date.now();
    const ts = readTs(host).filter((t) => now - t < WINDOW_MS);
    const wait = computeRateWait(ts, now, LIMIT, WINDOW_MS);
    if (wait < 0) {
      writeTs(host, [...ts, now]);
    }
    return wait;
  });
}

// 进程内串行化：同一个 host 的多次 acquire 串成一条链，避免一个进程内并发把窗口打满。
const chains = new Map<string, Promise<number>>();

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl || 'default';
  }
}

/**
 * 出网前调用：若本分钟内该 host 已发满 LIMIT 次，阻塞到最旧请求滑出窗口。
 * 这是 self-upgrade 循环对抗 NVIDIA 429 的统一闸门。
 */
export async function acquireRateLimit(baseUrl: string): Promise<void> {
  const host = hostOf(baseUrl);
  const prev = chains.get(host) ?? Promise.resolve(0);
  const next = prev.catch(() => {}).then(() => acquireOnce(host));
  chains.set(host, next);
  const wait = await next;
  if (wait > 0) {
    console.warn(`[rate-limit] host=${host} 已达 ${LIMIT}/min，等待 ${(wait / 1000).toFixed(1)}s`);
    await sleep(wait);
  }
}
