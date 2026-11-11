/**
 * propose-gaps.ts — 让 Agent 自己提名下一个该修的能力缺口。
 *
 * ── 为什么只能「提名」不能「出题」 ─────────────────────────────
 * 判据一旦由被衡量者自己写，它就会写一份让自己通过的判据——这是自利的，
 * 而且外置判据的全部意义（尺子在它够不到的地方）会被这一步抵消。
 *
 * 所以职责切得很死：
 *   · Agent（被衡量者）：只回答「**缺什么**」，给现象、给证据、给候选文件。
 *     它**不产出判据**，也**不写任何文件**。
 *   · 循环（本脚本）：把它的回答解析后写进 .self-upgrade/proposals.jsonl。
 *     那个目录在沙箱根之外（沙箱根 = server/），Agent 自己写不到。
 *   · 出题（author）：把提议转成规格与判据，这一步是独立环节，见 author-task.ts。
 *
 * ── 它拿到的输入 ────────────────────────────────────────────
 * 1) 现在有哪些工具（真实清单，来自运行中的服务）
 * 2) 最近的失败归因（来自账本，按层聚合）——**这就是闭环**：
 *    它知道上一轮卡在「行为层空转」还是「资源层预算耗尽」，
 *    于是提的缺口会指向真正的短板，而不是随口编一个。
 * 3) 已经做过哪些题（避免重复提议）
 *
 * 输出：一条 JSON，字段固定。没有 judge / allowed 之类的字段——
 * 不是靠提示词说「不许写」，是 schema 里根本没有这两个位置。
 */

import { existsSync, appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const SERVER = process.cwd();
const ROOT = path.join(SERVER, '..');

// 凭证与上游地址只从 .env / 进程环境读，源码里不写（与 env.ts 同一口径）。
// 少了这一步，请求会以 VALIDATION_ERROR 结束：apiKey / customBaseUrl 都是空的。
const envPath = path.join(SERVER, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
const PROPOSALS = path.join(ROOT, '.self-upgrade', 'proposals.jsonl');
const LEDGER = path.join(ROOT, '.self-upgrade', 'ledger.jsonl');
const TASKS = path.join(SERVER, 'self-upgrade', 'tasks.json');

const BASE = (process.env.UPGRADE_BASE ?? 'http://127.0.0.1:8099').replace(/\/$/, '');
const MODEL = process.env.RSI_MODEL ?? 'nemotron-3-ultra-550b-a55b';

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

interface Proposal {
  id: string;
  title: string;
  gap: string;
  evidence: string[];
  targetFile: string;
  observable: string;
  boundary: string;
}

function request(method: string, p: string, base = BASE): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(p, base);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d.toString()));
        res.on('end', () => resolve(buf));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** 账本里的失败按层聚合：它要知道自己卡在哪一层。 */
function failureDigest(): string {
  if (!existsSync(LEDGER)) return '（账本还没有失败记录）';
  const rows = readFileSync(LEDGER, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((r) => r.verdict === 'failed' && typeof r.layer === 'string');
  if (rows.length === 0) return '（没有带归因的失败）';
  const byLayer: Record<string, number> = {};
  const byCode: Record<string, number> = {};
  for (const r of rows) {
    byLayer[r.layer as string] = (byLayer[r.layer as string] ?? 0) + 1;
    byCode[r.code as string] = (byCode[r.code as string] ?? 0) + 1;
  }
  const fmt = (o: Record<string, number>): string =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}×${v}`)
      .join(' ');
  return `层分布 ${fmt(byLayer)}；原因码 ${fmt(byCode)}`;
}

/** 已做过的题：避免重复提议同一件事。 */
function doneTasks(): string {
  if (!existsSync(TASKS)) return '（无）';
  const raw = JSON.parse(readFileSync(TASKS, 'utf8')) as { tasks?: { id: string; title?: string }[] };
  return (raw.tasks ?? []).map((t) => `${t.id}｜${t.title ?? ''}`).join('\n');
}

/**
 * 提议的机械校验。
 *
 * 这里不判断「提议好不好」——那是出题环节和人的事。这里只挡三类废提议：
 *   · 指向的靶子不是 src/ 下的真实文件（没法改）
 *   · 指向受保护路径（tests/、krsi/、judge/、rsi/、eval/）——那是改尺子
 *   · 已经有同 id 的提议（重复）
 */
function screen(p: Proposal): { ok: boolean; reason?: string } {
  if (!p.id || !/^[a-z0-9][a-z0-9-]{2,40}$/.test(p.id)) return { ok: false, reason: 'id 必须是 kebab-case' };
  if (!p.title || p.title.length < 4) return { ok: false, reason: 'title 太短' };
  if (!p.gap || p.gap.length < 10) return { ok: false, reason: 'gap 说清楚缺什么（≥10 字）' };
  if (!Array.isArray(p.evidence) || p.evidence.length === 0) return { ok: false, reason: '必须给证据' };
  if (!p.targetFile || !p.targetFile.startsWith('src/')) return { ok: false, reason: 'targetFile 必须在 src/ 下' };
  for (const prot of ['tests/', 'krsi/', 'src/services/judge/', 'src/services/rsi/', 'src/services/eval/', 'scripts/']) {
    if (p.targetFile.startsWith(prot)) return { ok: false, reason: `targetFile 不能在受保护路径 ${prot} 下` };
  }
  if (!existsSync(path.join(SERVER, p.targetFile))) return { ok: false, reason: `targetFile 不存在：${p.targetFile}` };
  if (!p.observable || p.observable.length < 8) return { ok: false, reason: 'observable 说清楚「怎么看出修好了」' };
  if (!p.boundary || p.boundary.length < 4) return { ok: false, reason: 'boundary 说清楚这条不能碰什么' };
  return { ok: true };
}

function existingIds(): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(PROPOSALS)) return ids;
  for (const l of readFileSync(PROPOSALS, 'utf8').split('\n').filter(Boolean)) {
    try {
      ids.add((JSON.parse(l) as Proposal).id);
    } catch {
      /* 坏行忽略 */
    }
  }
  return ids;
}

/** 可改的源码文件清单（相对 server/）。不给清单它就会编路径 —— 上一轮它提的
 *  targetFile 是 src/agent/tool-planner.ts，这个文件根本不存在。 */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || out.length > 120) return;
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = readdirSync(path.join(SERVER, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
        walk(rel, depth + 1);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) {
        out.push(rel);
      }
    }
  };
  walk('src', 0);
  return out.slice(0, 120);
}

function buildPrompt(tools: string[], digest: string, done: string, files: string[]): string {
  return `你刚做完一轮「自我升级」，现在轮到你提下一个缺口。

你现在有的工具：
${tools}

可以改的源码文件（targetFile 必须从这份清单里挑，不要编路径）：
${files.join('\n')}

最近的失败归因（按层聚合）：
${digest}

已经做过的题（别重复提）：
${done}

──── 你要回答什么 ────
下一个**能力缺口**：现在这套系统还做不到、但应该做到的一件事。
必须是「缺一个能力」，不是「修一个 bug」也不是「优化一下」。

判定标准：一个具体场景，现在做不到，做到了就明显更好。
反例（不合格）：「提升代码质量」「优化性能」「让模型更聪明」。
正例（合格）：「工具执行失败时，模型看不到失败原因，只能猜」。

──── 输出格式 ────
**第一行必须是左花括号**。不要前言、不要解释、不要逐个点评工具、不要写推理过程。
直接输出这一个 JSON 对象，别的什么都没有：

{
  "id": "kebab-case-短标识",
  "title": "一句话说清缺口",
  "gap": "现在做不到什么，做到后能做什么（≥10 字）",
  "evidence": ["支撑这个缺口的现象，至少一条，尽量引用你刚经历过的具体失败"],
  "targetFile": "src/ 下真实存在的文件路径",
  "observable": "怎么看出它修好了：哪个输入、期望什么结果（≥8 字）",
  "boundary": "这条不能碰什么（越界即作废）"
}

不要写判据、不要写测试代码、不要写实现方案——那些不是你的活。
只提名。想不出来就输出 {"id":"none"}。`;
}

/**
 * 从模型输出里抠出那一个 JSON 对象。
 *
 * 不能用「第一个 { 到最后一个 }」——实测模型会先写一段话再给 JSON，
 * 那段话里往往也有花括号，区间切出来就不是合法 JSON 了。
 * 正确做法是**按括号平衡逐个尝试**：从每个 { 起点扫到配对的 }，再试解析。
 */
function balancedFrom(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function extractJson(text: string): Proposal | null {
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
    const chunk = balancedFrom(text, i);
    if (!chunk) continue;
    try {
      const obj = JSON.parse(chunk) as Record<string, unknown>;
      if (typeof obj.id !== 'string' || obj.id === 'none') continue;
      if (typeof obj.gap !== 'string') continue;
      return {
        id: String(obj.id),
        title: String(obj.title ?? ''),
        gap: String(obj.gap),
        evidence: Array.isArray(obj.evidence) ? obj.evidence.map((e) => String(e)) : [],
        targetFile: String(obj.targetFile ?? ''),
        observable: String(obj.observable ?? ''),
        boundary: String(obj.boundary ?? ''),
      };
    } catch {
      /* 这不是那个 JSON，换下一个起点 */
    }
  }
  return null;
}

async function main(): Promise<void> {
  // 服务不在就自己起一个（复用循环那套生命周期管理：专用端口、沙箱根正确、
  // 用完即停）。这样这个脚本既能单独跑，也能被循环调用。
  let base = BASE;
  let stop: (() => void) | null = null;
  const reachable = await new Promise<boolean>((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: Number(new URL(BASE).port || 80), path: '/api/health', method: 'GET', timeout: 1500 },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) === 200);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
  if (!reachable) {
    const { startLoopService } = await import('./loop-service.js');
    const svc = await startLoopService();
    base = svc.base;
    stop = svc.stop;
  }

  let tools: string[] = [];
  try {
    const raw = await request('GET', '/api/v1/tools', base);
    const list = (JSON.parse(raw) as { tools?: { name?: string }[] }).tools ?? [];
    tools = list.map((t) => String(t.name));
  } catch {
    tools = ['（工具清单取不到）'];
  }

  const message = buildPrompt(tools, failureDigest(), doneTasks(), sourceFiles());
  console.log(`▶ 请 Agent 提名缺口（模型 ${MODEL}）…`);

  const body = {
    provider: 'custom',
    model: MODEL,
    customBaseUrl: process.env.RSI_BASE_URL ?? process.env.TRIAL_BASE_URL ?? '',
    apiKey: process.env.RSI_API_KEY ?? process.env.LLM_SERVER_API_KEY ?? '',
    channelMode: 'native',
    maxTokens: 8192,
    maxIterations: 6,
    temperature: 0.2,
    message,
  };

  const sse = await new Promise<string>((resolve, reject) => {
    const url = new URL('/api/v1/agent/stream', base);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d.toString()));
        res.on('end', () => resolve(buf));
      },
    );
    req.on('error', reject);
    req.setTimeout(300_000, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });

  let text = '';
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const j = JSON.parse(line.slice(6)) as { text?: string };
      if (j.text) text += j.text;
    } catch {
      /* 非 JSON 行 */
    }
  }
  // 存原文：空输出时必须能看到「到底发生了什么」（上游空响应？被拦了？还是它真的什么都没说）。
  try {
    mkdirSync(path.join(ROOT, '.self-upgrade', 'loop'), { recursive: true });
    writeFileSync(path.join(ROOT, '.self-upgrade', 'loop', 'propose-sse.txt'), sse, 'utf8');
  } catch {
    /* 取不到就算了 */
  }

  const proposal = extractJson(text);
  if (!proposal) {
    console.log('  ✗ 它没给出可解析的提议（或选择「想不出来」）');
    console.log(`  原始输出末尾：${text.slice(-300).replace(/\n/g, ' ')}`);
    stop?.();
    return;
  }

  const v = screen(proposal);
  if (!v.ok) {
    console.log(`  ✗ 提议被机械筛掉：${v.reason}`);
    console.log(`     ${JSON.stringify(proposal, null, 2)}`);
    stop?.();
    return;
  }
  if (existingIds().has(proposal.id)) {
    console.log(`  ✗ 提议 id 已存在：${proposal.id}`);
    stop?.();
    return;
  }

  mkdirSync(path.dirname(PROPOSALS), { recursive: true });
  appendFileSync(
    PROPOSALS,
    `${JSON.stringify({ ...proposal, proposedAt: new Date().toISOString(), source: 'agent' })}\n`,
  );
  console.log(`  ✔ 提议已记入 ${path.relative(ROOT, PROPOSALS)}`);
  console.log(`    ${proposal.id}｜${proposal.title}`);
  console.log(`    靶子 ${proposal.targetFile}｜可观察 ${proposal.observable}`);
  console.log('    下一步：由出题环节把提议转成规格与判据（author-task.ts），判据仍需外置。');
  void arg;
  stop?.();
}

main().catch((e: unknown) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
