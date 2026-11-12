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
import { fileURLToPath } from 'node:url';
import { checkDomain } from '../src/services/rsi/change-domain.js';
import { TOOL_CONTRACT, appendRejection, recentExemplars, recentRejections } from './lib/agent-feedback.js';

const SERVER = process.cwd();
const ROOT = path.join(SERVER, '..');

// 凭证与上游地址只从 .env / 进程环境读，源码里不写（与 env.ts 同一口径）。
// 少了这一步，请求会以 VALIDATION_ERROR 结束：apiKey / customBaseUrl 都是空的。
const envPath = path.join(SERVER, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
const PROPOSALS = path.join(ROOT, '.self-upgrade', 'proposals.jsonl');
const LEDGER = path.join(ROOT, '.self-upgrade', 'ledger.jsonl');
const TASKS = path.join(SERVER, 'self-upgrade', 'tasks.json');
const BACKLOG = path.join(SERVER, 'self-upgrade', 'backlog.json');

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
  /**
   * 缺口类型，决定后续出题/采纳走哪条管线：
   *   defect     —— 现有能力在部分输入下行为错误/不安全/不符合预期，能用**现有**公开 API 复现验证。
   *                这类最优先，判据走 red-baseline：在现状上必须红，采纳后成为回归尺。
   *   capability —— 现在确实做不到、需要新增 API/字段/导出才能满足的功能。
   *                走 implement-first：先由 agent 实现该能力，再验证判据变绿后采纳。
   */
  gapType: 'defect' | 'capability';
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

/**
 * 已知缺口池（人维护）。
 *
 * 为什么需要它：让模型「自由提名」时，它经常直接回 `{"id":"none"}`——
 * 不是没有缺口，而是它不知道系统自己登记了哪些。
 * 而缺口其实一直摆在那里：宣言第 10 节的 UNEXEC 清单就是一份现成的池子。
 * 有了池子，它的活从「凭空想一个」变成「从已知缺口里挑一个能落地的」，
 * 并说清为什么现在挑它。
 */
function backlogDigest(): string {
  if (!existsSync(BACKLOG)) return '（缺口池为空）';
  try {
    const j = JSON.parse(readFileSync(BACKLOG, 'utf8')) as {
      items?: { id: string; title: string; why: string; targetHint?: string; size?: string; agentActionable?: boolean }[];
    };
    // 只把「能做」的交给它：靶子在 scripts/ 或 judge/ 下的缺口改的是尺子，只能人做。
    // 混在一起给它，它会挑一条看着最该做的、然后必然被机械筛挡掉——白跑一轮。
    const items = (j.items ?? []).filter(
      (i) => i.agentActionable === true && (i as { status?: string }).status !== 'done',
    );
    if (items.length === 0) return '（当前没有可自动做的缺口，需要人工补题）';
    return items
      .map((i) => `· ${i.id}｜${i.title}（规模 ${i.size ?? '?'}，靶子参考 ${i.targetHint ?? '?'}）\n  为什么算缺口：${i.why}`)
      .join('\n');
  } catch {
    return '（缺口池读取失败）';
  }
}

/** 已做过的题：避免重复提议同一件事。 */
function doneTasks(): string {
  if (!existsSync(TASKS)) return '（无）';
  const raw = JSON.parse(readFileSync(TASKS, 'utf8')) as { tasks?: { id: string; title?: string }[] };
  return (raw.tasks ?? []).map((t) => `${t.id}｜${t.title ?? ''}`).join('\n');
}

/**
 * 靶子是否落在**可自动采纳的 D1 域**（src/tools/ 或 src/utils/ 下的叶子能力）。
 *
 * 自动管线（无人值守、无人批）只允许 D1：D2 首次需人批、D3 每次需人批、D4 是尺子
 * 严禁自动改。所以提议若指向 D2/D3，A4 域闸必然拦下 —— 与其让采纳端拒、白烧一轮，
 * 不如在提议端就只给 / 只收 D1 靶子。这条是纯函数，便于单测自证。
 */
export function isAdoptableTarget(file: string): boolean {
  return checkDomain({ files: [file], trigger: 'schedule', humanApproved: false }).ok;
}

/**
 * 提议的机械校验。
 *
 * 这里不判断「提议好不好」——那是出题环节和人的事。这里只挡四类废提议：
 *   · 指向的靶子不是 src/ 下的真实文件（没法改）
 *   · 指向受保护路径（tests/、krsi/、judge/、rsi/、eval/）——那是改尺子
 *   · 靶子不在可自动采纳的 D1 域（D2/D3 需人批，自动管线收不了）
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
  if (!isAdoptableTarget(p.targetFile)) {
    return { ok: false, reason: `targetFile 不在可自动采纳的 D1 域（仅 src/tools/、src/utils/）：${p.targetFile}` };
  }
  if (!p.observable || p.observable.length < 8) return { ok: false, reason: 'observable 说清楚「怎么看出修好了」' };
  if (!p.boundary || p.boundary.length < 4) return { ok: false, reason: 'boundary 说清楚这条不能碰什么' };
  if (p.gapType !== 'defect' && p.gapType !== 'capability') return { ok: false, reason: 'gapType 必须是 defect 或 capability' };
  // defect 必须引用**具体行号**：这是「真的读过实现」与「凭想象编缺口」之间唯一可机械判定的差别。
  // 编出来的字段（error.matches）就是没读代码的产物，这一闸专治它。
  if (p.gapType === 'defect') {
    const hasLine = p.evidence.some((e) => /[:：]\s*\d{1,5}\b|\bline\s*\d{1,5}\b|第\s*\d{1,5}\s*行/i.test(String(e)));
    if (!hasLine) {
      return {
        ok: false,
        reason: 'defect 的 evidence 没有引用具体行号——判为「没读源码的臆测」。先用工具读实现，再写带行号的证据',
      };
    }
  }
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

/** 已提过的提议，避免重复提名同一件事。 */
function propsDigest(): string {
  const ids = [...existingIds()];
  return ids.length ? ids.join('、') : '（还没有提过）';
}

function buildPrompt(tools: string[], digest: string, done: string, files: string[]): string {
  return `你刚做完一轮「自我升级」，现在轮到你提下一个缺口。

你现在有的工具：
${tools}

可以改的源码文件（targetFile 必须从这份清单里挑，不要编路径）：
${files.join('\n')}

⚠ 域约束（决定这条提议能否被自动采纳）：只有 **D1 域**的文件能被自动管线采纳落地——
即 \`src/tools/\` 与 \`src/utils/\` 下的叶子能力（工具实现、纯函数）。\`src/services/\`、\`src/middlewares/\`、
\`src/routes/\`、\`src/controllers/\` 等属于 D2/D3，自动采纳每次都要人批，**自动管线采纳不了**。
所以：优先从 \`src/tools/\` 或 \`src/utils/\` 里挑靶子；除非你确认那是能用现有公开 API
直接复现/验证的行为缺陷，否则不要选服务层/架构层文件（选了也会被域闸拦下，白跑一轮）。

最近的失败归因（按层聚合）：
${digest}

已经做过的题（别重复提）：
${done}

──── 已知缺口池（优先从这里挑，也可以提池子之外的）────
${backlogDigest()}

──── 已经提过的缺口（别再提同一件事）────
${propsDigest()}

──── 你的历史错题（硬事实，同一错法再犯就是浪费一轮）────
${recentRejections(5)}

──── 成功样例（这些是真的被采纳过的，照它们的形状找）────
${recentExemplars(2)}

──── 动手之前：你必须先读源码 ────
你有 fs.read / grep 这类工具。**不允许**只看文件名就猜缺口——那是臆测，会被机械闸直接拒。
正确顺序：
  1) 从上面清单里挑 1 个 D1 文件；
  2) 用工具把它的**实现完整读一遍**（必要时再读它依赖的类型/工具）；
  3) 在代码里找「某个输入下行为不对」的那一行，再写提议。
evidence 里**必须有一条带具体行号**（形如 \`fs-write.tool.ts:118\`），并写清：什么输入、当前给出什么、为什么不对。
没有行号的 evidence 会被判为「没读过代码」，整条提议作废。

⚠ 预算纪律（实测踩过）：你只有有限的工具调用次数，上一轮就读文件读到超预算，
  被截断在半句话上，整条提议作废。所以：
  · 读文件**最多 3 次**（优先读你选中的那一个靶子文件；够用就停）；
  · 读完后**立刻**输出 JSON，不要复述代码、不要写"让我继续读"这类过程话；
  · 拿不准的细节就不写，宁可证据少一条，也要把 JSON 完整吐出来。

──── 工具返回值契约（硬事实，不得发明字段）────
${TOOL_CONTRACT}

──── defect 的原型（照这些形状找，别凭空想功能）────
  · 错误分型错：该 invalid_args / not_found 的分支给了 unknown，调用方无法据 kind 决定重试；
  · 边界值错：0 次匹配 / 多次匹配 / 空字符串 / 末尾换行 / CRLF 下行为不一致；
  · 校验漏分支：相对路径 ../ 逃逸、符号链接、大小写、超长输入未被拦；
  · 半成品：多步写入中途失败后留下部分修改，且没有回滚或明确报错；
  · 契约不一致：description / inputSchema 声明支持的参数，handler 实际没实现或实现不符。

──── 你要回答什么 ────
下一个**能力缺口**：现在这套系统还做不到、但应该做到的一件事。
分两类，你必须二选一，并在 JSON 里写 \`gapType\`：

  · defect（优先）：系统**已有**这个能力，但在某些输入下行为错误 / 不安全 / 不符合预期，
    而且能用**现有**公开 API 直接复现、直接验证（不要新增字段、不要新增参数、不要新增导出）。
    例：「工具执行失败时，错误只报 kind，模型看不到该改什么」「多文件改动中途失败会留半成品」。
  · capability：现在确实做不到、必须**新增 API / 字段 / 导出**才能满足的功能。
    例：「给 fs.write 加一个批量原子写入口」。

**优先提 defect**：它能被自动判据直接验证并采纳，是闭环价值最高的一类。
capability 也接受，但会走「先实现后采纳」管线（见 boundary）。

⚠ 标 defect 之前的自检（必须过，否则一定被拒）：
  · 你的 observable 里如果出现「返回 / 新增 / 带上 X 字段」→ 你要的是新 API，**必须标 capability**；
  · 你的 evidence 里如果没有一行现成代码能证明「现在就是错的」→ 这不是 defect，别标它。

判定标准：一个具体场景，现在做不到/做不对，做到了就明显更好。
反例（不合格）：「提升代码质量」「优化性能」「让模型更聪明」。

──── 输出格式 ────
**第一行必须是左花括号**。不要前言、不要解释、不要逐个点评工具、不要写推理过程。
直接输出这一个 JSON 对象，别的什么都没有：

{
  "id": "kebab-case-短标识",
  "title": "一句话说清缺口（≤30 字）",
  "gapType": "defect 或 capability（二选一）",
  "gap": "现在做不到什么/做错什么、做到了能做什么（≥10 字，≤80 字）",
  "evidence": ["支撑现象，最多 2 条，每条 ≤60 字；**第 1 条必须带行号**，如 fs-write.tool.ts:118"],
  "targetFile": "src/ 下真实存在的文件路径",
  "observable": "怎么看出修好了：哪个输入、期望什么结果（≤60 字）",
  "boundary": "这条不能碰什么（≤40 字）"
}

**篇幅是硬约束**：整个 JSON 必须在一屏内写完。输出上限是 8192 token，
上一轮你写了很长的 evidence，JSON 在中途被截断，整份提议作废。
宁可少写一条证据，也不要被截断。

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
      const rawType = typeof obj.gapType === 'string' ? (obj.gapType as string).toLowerCase() : '';
      const gapType: 'defect' | 'capability' =
        rawType === 'capability' ? 'capability' : rawType === 'defect' ? 'defect' : 'defect';
      return {
        id: String(obj.id),
        title: String(obj.title ?? ''),
        gap: String(obj.gap),
        evidence: Array.isArray(obj.evidence) ? obj.evidence.map((e) => String(e)) : [],
        targetFile: String(obj.targetFile ?? ''),
        observable: String(obj.observable ?? ''),
        boundary: String(obj.boundary ?? ''),
        gapType,
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

  // 只把 D1 叶子能力列给模型：D2/D3 需人批、自动管线采纳不了，列出来只会诱导它白提。
  const message = buildPrompt(
    tools,
    failureDigest(),
    doneTasks(),
    sourceFiles().filter(isAdoptableTarget),
  );
  console.log(`▶ 请 Agent 提名缺口（模型 ${MODEL}）…`);

  const body = {
    provider: 'custom',
    model: MODEL,
    customBaseUrl: process.env.RSI_BASE_URL ?? process.env.TRIAL_BASE_URL ?? '',
    apiKey: process.env.RSI_API_KEY ?? process.env.LLM_SERVER_API_KEY ?? '',
    channelMode: 'native',
    maxTokens: 8192,
    // 6 次不够：要求它先读源码后，实测 6 次会全花在读文件上、被截断在半句话里。
    // 12 次能覆盖「读 1 个靶子 + 查 1 个类型 + 作答」，且不会多花钱（读完就停）。
    maxIterations: 12,
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
    // 落进错题本：下一轮原样回灌「你上次因为什么被拒」，否则它会一直重复同一种错法。
    appendRejection({
      id: String(proposal.id ?? 'unknown'),
      stage: 'propose',
      code: 'SCREEN_REJECTED',
      detail: `${v.reason ?? ''}｜原文：${JSON.stringify({ evidence: proposal.evidence, observable: proposal.observable, targetFile: proposal.targetFile }).slice(0, 240)}`,
      fix: '按拒绝理由修正后重提：defect 必须先在源码里定位到出错行，evidence 带行号；要新增字段就改标 capability',
    });
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
  console.log(`    gapType=${proposal.gapType}${proposal.gapType === 'capability' ? '（走 implement-first 管线）' : ''}`);
  console.log(`  ✔ 提议已记入 ${path.relative(ROOT, PROPOSALS)}`);
  console.log(`    ${proposal.id}｜${proposal.title}`);
  console.log(`    靶子 ${proposal.targetFile}｜可观察 ${proposal.observable}`);
  console.log('    下一步：由出题环节把提议转成规格与判据（author-task.ts），判据仍需外置。');
  void arg;
  stop?.();
}

// 入口守卫：允许测试 import isAdoptableTarget() 做单元验证，不触发整轮实跑（会起服务 + 真调模型）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
