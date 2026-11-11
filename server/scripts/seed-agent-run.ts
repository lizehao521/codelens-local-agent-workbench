/**
 * seed-agent-run.ts — 真跑一次 Agent，触发 RSI 闭环。
 *
 * 流程：
 *   1. POST /agent/stream —— Agent 真实执行一个任务（读强化Agent.txt → 总结闭环）
 *   2. 等 SSE done（最长 3min）
 *   3. 打印 judge_runs + policy_rsi_runs + policy_injections 新增行
 *
 * 设计：
 *   - 用同一个 session（demo-session-002）跑两次 → 第二次 krsi 才能做 prev→next 对比
 *   - 归因器会在 krsi 判 not_improved/refused 时触发，自动写 policy_injections
 *   - 跑完后可以直接在看板 http://localhost:8080/rsi?session=demo-session-002 看效果
 */

import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tsx 不会自动读 .env，而凭证只从环境变量取，所以这里自己加载一次。
const ENV_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const BASE = 'http://127.0.0.1:8080';

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

async function getJSON(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d.toString()));
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { reject(new Error('bad json: ' + buf.slice(0, 100))); }
      });
    }).on('error', reject);
  });
}

function parseDone(sse: string): { runId?: string; sessionId?: string; verdict?: string; tokens?: number } {
  const out: { runId?: string; sessionId?: string; verdict?: string; tokens?: number } = {};
  // SSE 格式: event: <type>\ndata: <json>\n
  const lines = sse.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('event:')) {
      const ev = line.slice(6).trim();
      const next = lines[i + 1];
      if (!next?.startsWith('data:')) continue;
      let d: any;
      try { d = JSON.parse(next.slice(5).trim()); } catch { continue; }
      if (ev === 'run:done') {
        out.runId = d.runId; out.sessionId = d.sessionId;
        out.verdict = d.verdict ?? d.finishReason;
        out.tokens = d.totalTokens ?? d.tokens;
      } else if (ev === 'run:start' && !out.sessionId) {
        out.sessionId = d.sessionId;
      } else if (ev === 'error') {
        console.error(`  SSE error: ${JSON.stringify(d).slice(0, 200)}`);
      }
    }
  }
  return out;
}

/** 从 SSE 里找第一个 meta 事件拿 sessionId */
function getSessionId(sse: string): string | null {
  const lines = sse.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('event:') && lines[i].includes('meta')) {
      const next = lines[i + 1];
      if (!next?.startsWith('data:')) continue;
      try { return JSON.parse(next.slice(5).trim()).sessionId ?? null; } catch { return null; }
    }
  }
  return null;
}

async function main() {
  // 让后端自动生成 sessionId（uuid），第一次 run 的 done 事件里会带 sessionId
  let sessionId: string | null = null;
  const baseArgs = {
    provider: 'custom',
    model: 'deepseek-chat',
    customBaseUrl: 'http://1.92.150.5:8787/v1',
    apiKey: process.env.LLM_SERVER_API_KEY ?? '',
    channelMode: 'react',
    maxIterations: 8,
    temperature: 0.2,
    maxTokens: 1024,
  };

  for (const pass of [1, 2]) {
    console.log(`\n═══ PASS ${pass} ═══`);
    const message = pass === 1
      ? '读 /workspace/.uploads/c0c673c2-1a29-486c-97c5-1bca600b8d54_强化Agent.txt，用 3 句话总结其中的核心闭环公式。不要跑别的任务，只总结。'
      : '再读一次 /workspace/.uploads/c0c673c2-1a29-486c-97c5-1bca600b8d54_强化Agent.txt，列出 "四条铁律" 的名称和一句话解释。';

    const startedAt = Date.now();
    const body = { ...baseArgs, message, ...(sessionId ? { sessionId } : {}) };
    console.log(`▶ POST /agent/stream  message="${message.slice(0, 60)}…"`);
    let sse: string;
    try {
      sse = await postStream(body);
    } catch (e: any) {
      console.error('❌ stream failed:', e?.message ?? e);
      continue;
    }
    const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
    // 打印 SSE 事件流（debug）
    const events: string[] = [];
    const lines = sse.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('event:')) {
        const ev = line.slice(6).trim();
        const next = lines[i + 1];
        let d = '';
        if (next?.startsWith('data:')) {
          try { d = JSON.stringify(JSON.parse(next.slice(5).trim())).slice(0, 80); } catch { d = next.slice(5).slice(0, 80); }
        }
        events.push(`${ev}: ${d}`);
      }
    }
    console.log(`  events (${events.length}): ${events.slice(0, 10).join(' | ')}${events.length > 10 ? ' …' : ''}`);

    // 从 meta 事件拿 sessionId（最可靠）
    if (!sessionId) sessionId = getSessionId(sse);

    // 同时跑 done 解析（可能 run:done 不存在——说明 Agent 断了）
    const done = parseDone(sse);
    console.log(`✅ done in ${dur}s  runId=${done.runId}  verdict=${done.verdict}  tokens=${done.tokens ?? '?'}`);
  }

  // ── 打印 RSI 状态 ──
  console.log('\n═══ RSI 状态（demo-session-002） ═══');
  const ov = await getJSON(`/api/rsi/overview?session=${sessionId}`);
  console.log(`judgeRuns: ${ov.judgeRuns?.length ?? 0}`);
  for (const r of ov.judgeRuns ?? []) {
    console.log(`  run#${r.id}  verdict=${r.verdict}  score=${r.score}  coverage=${r.coverage}`);
  }
  console.log(`rsiRuns: ${ov.rsiRuns?.length ?? 0}`);
  for (const r of ov.rsiRuns ?? []) {
    const reasons = JSON.parse(r.reasons_json || '[]').join(' | ');
    console.log(`  ${r.prev_generation}→${r.generation}  ${r.verdict}  exit=${r.exit_code}  ${reasons.slice(0, 80)}`);
  }
  console.log(`attributions: ${ov.attributions?.length ?? 0}`);
  for (const a of ov.attributions ?? []) {
    console.log(`  #${a.id}  policy=${a.policy_version}  ${a.lesson?.slice(0, 80) ?? ''}`);
  }
  console.log('\n看板: http://localhost:8080/rsi?session=' + sessionId);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
