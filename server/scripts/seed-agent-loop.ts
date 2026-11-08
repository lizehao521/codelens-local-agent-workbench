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
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:8080';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TASKS = [
  '读 /workspace/.uploads/c0c673c2-1a29-486c-97c5-1bca600b8d54_强化Agent.txt，用 3 句话总结核心闭环公式。',
  '列出 "四条铁律" 的名称和一句话解释。',
  '用自己的话复述 C3「自证」是什么意思，给一个违反它的例子。',
  '判据塔 L0-L3 各层回答什么问题？低层为什么不能替高层签字？',
  '§6 工具纪律说"用完就删"——删除前必须回答的"沉淀三问"是什么？',
  '解释"UNEXEC 也绝不等于 PASS"这个约束在判据塔里的作用。',
  '为什么说"r 必须真的改变 π\'，π\' 必须真的改变下一次 Act"？举一个断环的例子。',
  'C1「中心性」怎么用来识别装饰？举一个装饰模块的例子和一个强化模块的例子。',
  '终止条件一节为什么说"饱和不是终点"？饱和了应该扩什么？',
  '把整个强化内核宣言压缩成一条 10 行以内的代码注释，保留公式和四条铁律的精神。',
  '再读一遍 §6 工具纪律，画一张"工具生命周期"的状态流转表（6 步）。',
  '对比 C3「自证」和 C4「不外推」，它们各自约束闭环的哪一段？',
];

const baseArgs = {
  provider: 'custom',
  model: 'deepseek-chat',
  customBaseUrl: 'http://1.92.92.200:8787/v1',
  apiKey: 'sk-relay-qYbr8zxWfqAENi8rMCKvNg4-C_OFymcS',
  channelMode: 'react',
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

  for (let i = 0; i < target; i++) {
    const task = TASKS[i % TASKS.length];
    const start = Date.now();
    starts.push(start);

    console.log(`\n── ROUND ${i + 1}/${target} ──`);
    console.log(`▶ ${task.slice(0, 80)}…`);

    let sse: string;
    try {
      sse = await postStream({ ...baseArgs, message: task, ...(sessionId ? { sessionId } : {}) });
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

    // 等一小段时间让 JudgeService + RsiBridge 跑完（它们是同步的，但 RsiBridge 里面有 spawn krsi）
    await new Promise((r) => setTimeout(r, 1500));
  }

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
  const ledgerPath = path.join(ROOT, 'data', 'rsi', `${sessionId}.jsonl`);
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
