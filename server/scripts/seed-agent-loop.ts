/**
 * seed-agent-loop.ts — 连续 N 轮触发 RSI 闭环，推到 generation >= target。
 *
 * 与 seed-agent-run.ts 的区别：
 *   - 用**同一个 sessionId** 循环 N 轮 → session-scoped generation 自动累加
 *   - 每轮任务不同（避免同一个 prompt 反复跑同样的轨迹）
 *   - 跑完后打印每代 diff（manifest 读数变化 + Anchor 链 + π 增量）
 *
 * 用法：timeout 1800 node --import tsx scripts/seed-agent-loop.ts 12
 *   → 连续 12 轮，推到 generation=11（gen1=skipped, gen2..gen12=compared）
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../src/repositories/db.js';

const BASE = 'http://127.0.0.1:8080';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.AGENT_DB_PATH
  ? path.resolve(process.env.AGENT_DB_PATH)
  : path.join(ROOT, 'data', 'codelens.db');

/**
 * 任务序列刻意做成「长任务 + 故意失败」→「短任务 + 全成功」的交替。
 *
 * 为什么不能全用读文件问答：krsi 的 R5 要求**每个** metric 严格变好。
 * 读文件问答轮次的 tool_success_rate 恒等于 1.0 —— 1→1 永远不算变好，
 * 于是无论跑多少轮都只能拿到 not_improved / refused。这是数学上的死路，
 * 不是代码 bug。要让它真的能判 improved，必须制造一次「上一代更差」：
 *   · 上一代先跑一条注定失败的命令（ls 不存在的目录）→ success_rate < 1
 *   · 本代只跑成功命令 → success_rate = 1.0，严格变好
 *   · 同时本代不读长文件 → token 消耗更低，budget_efficiency 也严格变好
 * 两个 metric 同时严格变好，krsi 才会给出 exit 0 = improved。
 *
 * 标记说明：[差] = 读长文件 + 一次必失败的读取；[好] = 轻量 + 全成功。
 *
 * 两个环境约束（都踩过坑）：
 *   1. channelMode 必须用 'native'：'react' 的文本协议会被模型写成 `</tool_call>`，
 *      解析错位后最终回答被吞成空串，Judge 只能拿到 S1_empty_answer。
 *   2. 不能用 sys.exec：它是 hard 审批，无人值守会卡在 approval 上不返回。
 *      制造失败率改用「读不存在的文件」（fs.read 无审批），写文件用 fs.write（soft，自动放行）。
 */
// 必须放在沙箱根目录（server/workspace）内：
// 读沙箱外的 /workspace/.uploads 会触发目录授权，无人值守时请求会一直挂着
// 直到客户端超时（实测单轮 195s 后才返回）。
const TXT = 'notes/强化Agent.txt';
/** 故意指向不存在的文件 —— fs.read 会失败，用来制造真实的工具失败率。 */
const MISSING = 'scratch/does-not-exist.md';

const TASKS = [
  // 1 基线：读一段 + 写文件（无上代，判 skipped）
  `读 ${TXT} 第 1-25 行，用 3 句话总结核心闭环公式，写入 scratch/round-01.md。`,
  // 2 [差]：读一段 + 一次注定失败的读取（工具失败率 < 1）+ 写文件
  `先读 ${TXT} 第 1-25 行；再读 ${MISSING}（它不存在，失败也要如实继续）；最后把闭环公式写入 scratch/round-02.md。`,
  // 3 [好]：轻量 + 全成功（相对第 2 代应判 improved）
  // 必须带一次真实工具调用：模型如果直接答题，tool.success_rate 会变成 unexec，
  // 读数缺失会让 krsi 判 undecidable（"只有上一代有，量不到改进"）。
  `先用 fs.read 读取 scratch/round-01.md 的第一行，再把「四条铁律」四个名称各一行写入 scratch/round-03.md。`,
  // 4：读一段 + 表格
  `读 ${TXT} 第 26-60 行，把判据塔 L0-L3 各层回答什么问题整理成表格，写入 scratch/round-04.md。`,
  // 5 [差]：读一段 + 失败读取 + 写文件
  `读 ${TXT} 第 61-90 行；再读 ${MISSING}（不存在，失败也继续）；把「沉淀三问」写入 scratch/round-05.md。`,
  // 6 [好]：轻量 + 全成功
  `先用 fs.read 读取 scratch/round-01.md 的第一行，再把「UNEXEC 绝不等于 PASS」的一句话解释写入 scratch/round-06.md。`,
  // 7：断环例子
  `读 ${TXT} 第 1-30 行，举一个「r 没有真的改变 π'」的断环例子，写入 scratch/round-07.md。`,
  // 8：C1 中心性
  `读 ${TXT} 第 31-70 行，用 C1「中心性」区分一个装饰模块和一个强化模块，各举一例写入 scratch/round-08.md。`,
  // 9 [差]：读一段 + 失败读取 + 写文件
  `读 ${TXT} 第 71-100 行；再读 ${MISSING}（不存在，失败也继续）；把「饱和后该扩什么」写入 scratch/round-09.md。`,
  // 10 [好]：轻量 + 全成功
  `先用 fs.read 读取 scratch/round-01.md 的第一行，再把强化内核公式写成一行代码注释写入 scratch/round-10.ts。`,
  // 11：状态表
  `读 ${TXT} 第 101-135 行，把工具生命周期 6 步画成状态流转表写入 scratch/round-11.md。`,
  // 12：C3 vs C4
  `读 ${TXT} 第 1-40 行，对比 C3「自证」和 C4「不外推」各自约束闭环哪一段，写入 scratch/round-12.md。`,
];

const baseArgs = {
  provider: 'custom',
  model: 'deepseek-chat',
  customBaseUrl: 'http://1.92.92.200:8787/v1',
  apiKey: 'sk-relay-qYbr8zxWfqAENi8rMCKvNg4-C_OFymcS',
  channelMode: 'native',
  maxIterations: 8,
  temperature: 0.2,
  maxTokens: 1024,
};

// ── HTTP 工具 ──────────────────────────────────────────────────────────────

async function postStream(body: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/v1/agent/stream', BASE);
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d.toString()));
        res.on('end', () => resolve(buf));
      },
    );
    req.on('error', reject);
    req.setTimeout(180_000, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

/**
 * 带退避重试的流式请求。
 *
 * 中转网关在上游连续失败时会熔断，返回 HTTP 503 breaker_open / rate_limited。
 * 这不是 prompt 或代码的问题，退避等待后通常自行恢复 —— 所以必须重试，
 * 否则一次限流会把后面所有轮次连锁打空（实测第 3 轮起全 0.5s 失败）。
 */
async function postStreamWithRetry(
  body: Record<string, unknown>,
  attempts = 4,
): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const sse = await postStream(body);
      const throttled =
        sse.includes('"code":"UPSTREAM_ERROR"') ||
        sse.includes('rate_limited') ||
        sse.includes('breaker_open');
      if (!throttled) return sse;
      lastErr = new Error('上游限流/熔断');
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) {
      const waitMs = 20_000 * (i + 1);
      console.log(`  ⏳ 上游限流，${waitMs / 1000}s 后重试（${i + 2}/${attempts}）`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function getJSON(p: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d.toString()));
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { reject(new Error('bad json: ' + buf.slice(0, 100))); }
      });
    }).on('error', reject);
  });
}

function getSessionId(sse: string): string | null {
  const lines = sse.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('event:')) {
      const next = lines[i + 1];
      if (!next?.startsWith('data:')) continue;
      try {
        const d = JSON.parse(next.slice(5).trim());
        if (lines[i].includes('run:start')) return d.sessionId ?? null;
        if (lines[i].includes('meta')) return d.sessionId ?? null;
      } catch { /* skip */ }
    }
  }
  return null;
}

// ── 主循环 ──────────────────────────────────────────────────────────────────

async function main() {
  const target = Math.max(2, parseInt(process.argv[2] || '12', 10));
  console.log(`\n═══ RSI 自迭代闭环：目标 ${target} 轮 ═══\n`);

  let sessionId: string | null = null;
  const starts: number[] = [];
  const db = createDb(DB_PATH);

  for (let i = 0; i < target; i++) {
    const task = TASKS[i % TASKS.length];
    const start = Date.now();
    starts.push(start);

    console.log(`\n── ROUND ${i + 1}/${target} ──`);
    console.log(`▶ ${task.slice(0, 80)}…`);

    let sse: string;
    try {
      sse = await postStreamWithRetry({ ...baseArgs, message: task, ...(sessionId ? { sessionId } : {}) });
    } catch (e: any) {
      console.error(`  ❌ stream failed: ${e?.message ?? e}`);
      continue;
    }
    if (!sessionId) sessionId = getSessionId(sse);

    const dur = ((Date.now() - start) / 1000).toFixed(1);
    // 快速摘要：只看 event 行
    const events: string[] = [];
    const lines = sse.split('\n');
    for (let j = 0; j < lines.length; j++) {
      const l = lines[j];
      if (l.startsWith('event:')) {
        const ev = l.slice(6).trim();
        if (['run:start', 'run:done', 'error', 'stage'].includes(ev) || ev.startsWith('stage')) {
          events.push(ev);
        }
      }
    }
    const lastStages = events.filter((e) => e !== 'run:start').slice(-6);
    console.log(`  ✅ ${dur}s  stages=[${lastStages.join('|')}]  session=${sessionId}`);

    // 等 JudgeService + RsiBridge 跑完（同步执行，但 RsiBridge 里有 spawn krsi），
    // 同时给上游留出限流窗口：连续 12 轮密集请求很容易触发网关熔断。
    await new Promise((r) => setTimeout(r, 6000));

    // ── 隔离测量上下文 ────────────────────────────────────────────────────────
    // 每一代都要在**干净的上下文**里评测，否则会话历史逐轮累积，
    // budget_efficiency（用量/预算）会单调上升 —— 数学上永远不可能"严格变好"，
    // krsi 只能一直判 not_improved。这与「用隐藏集独立测量」是同一条纪律：
    // 上一代的记忆不该成为下一代测量结果的一部分。
    //
    // RSI 真正的学习状态存在 policy_versions / policy_injections 里（会跨轮注入），
    // 聊天消息只是这一次运行的脚手架，清掉不影响闭环。
    if (sessionId) {
      try {
        db.run('DELETE FROM tool_calls WHERE session_id = ?', [sessionId]);
        db.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
      } catch (e) {
        console.warn(`  ⚠ 清理历史失败（继续）: ${(e as Error).message}`);
      }
    }
  }
  db.close();

  // ── 打印汇总报告 ──
  console.log(`\n\n═══════════════════════════════════════════════`);
  console.log(`  RSI 自迭代闭环汇总（session=${sessionId}）`);
  console.log(`═══════════════════════════════════════════════\n`);

  const ov = await getJSON(`/api/rsi/overview?session=${sessionId}`);

  // judge_runs
  const judgeRuns = ov.judgeRuns ?? [];
  console.log(`【判决塔】${judgeRuns.length} 次 Judge 判决：`);
  for (const r of judgeRuns) {
    console.log(`  run#${r.id}  verdict=${r.verdict}  score=${(+r.score).toFixed(3)}  cov=${(+r.coverage).toFixed(3)}`);
  }

  // policy_rsi_runs（逐代）
  const rsiRuns = ov.rsiRuns ?? [];
  console.log(`\n【RSI 代际】${rsiRuns.length} 代 krsi 对账：`);
  for (const r of rsiRuns) {
    const reasons = JSON.parse(r.reasons_json || '[]');
    const prevGen = r.prev_generation ?? 0;
    const verdict = r.verdict;
    const reasonStr = reasons.length ? ` | ${reasons.map((x: string) => x.replace(/^R\d+:\s*/, '')).join('；').slice(0, 80)}` : '';
    console.log(`  g${prevGen}→g${r.generation}  ${verdict.padEnd(12)}  exit=${r.exit_code ?? '-'}${reasonStr}`);
  }

  // policy_injections（每代归因）
  const injections = ov.attributions ?? [];
  console.log(`\n【归因经验】${injections.length} 条 π 增量（policy_injections）：`);
  const byPolicy: Record<number, string[]> = {};
  for (const a of injections) {
    const v = +a.policy_version;
    (byPolicy[v] ||= []).push(a.lesson?.slice(0, 100) ?? '');
  }
  for (const v of Object.keys(byPolicy).map(Number).sort((a, b) => a - b)) {
    console.log(`  policy#${v}:`);
    for (const l of byPolicy[v]) console.log(`    · ${l}`);
  }

  // Anchor 链
  console.log(`\n【Anchor 哈希链】`);
  // 锚链在独立文件里（krsi 的 .jsonl 是它自己的私有账本，不能混写）
  const ledgerPath = path.join(ROOT, 'data', 'rsi', `${sessionId}-anchors.jsonl`);
  const { readFileSync } = await import('node:fs');
  try {
    const content = readFileSync(ledgerPath, 'utf-8');
    const anchors = content.split('\n').filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter((o) => o && o.type === 'anchor');
    if (anchors.length === 0) {
      console.log(`  ⚠ 没有 anchor 行（首次运行 / ledger 被清过）`);
    } else {
      let prev: string | null = null;
      for (const a of anchors) {
        const ok = a.prev_anchor_hash === prev;
        console.log(`  g${a.generation}  verdict=${a.verdict.padEnd(12)}  chain=${ok ? '✓' : '✗'}  hash=${a.anchor_hash.slice(0, 16)}…`);
        prev = a.anchor_hash;
      }
      console.log(`  ✓ 链头 = ${prev?.slice(0, 32)}…`);
    }
  } catch (e) {
    console.log(`  ⚠ ledger 读失败: ${(e as Error).message}`);
  }

  console.log(`\n看板: http://localhost:8080/rsi?session=${sessionId}`);
  console.log(`═══════════════════════════════════════════════\n`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
