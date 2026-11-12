/**
 * 桥接派单：把「当前 WorkBuddy 会话」接成 RSI 的 Actor。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 项目原本的派单链路是：本地服务 → LLM 上游（8787）。上游一断，整条链就空转，
 * 而 run_report 里「没有工具调用、没有正文」和「模型只说不做」几乎同形。
 *
 * 有两条路能把「会话里这个模型」接进来，实测结果：
 *   · 直接给脚本一个 API key —— 不存在。会话模型没有对外暴露的端点，
 *     不能把一个后台 Node 进程「插」到当前会话的推理上。
 *   · 本机 codebuddy CLI（-p 非交互）—— 独立进程不继承会话登录态，
 *     实测报 "Authentication required. Please use /login"，且共用同一账号额度。
 *
 * 于是走第三条：**会话在环**。循环把任务书导出到仓库内的桥接目录（沙箱外、
 * 跨会话可见），会话读它、按任务书改代码、写一份回执；循环收到回执后照常
 * 跑围栏 / 归因 / 账本。被换掉的只是 Actor，尺子一道没动。
 *
 * ── 信任边界（重要）────────────────────────────────────────────────────
 * 1. 桥接**绕过**了 /api/v1/agent/stream 的 path-jail 沙箱。兜底全部落在围栏：
 *    git diff 只允许 allowed、受保护文件指纹不变、判据必须绿、全量必须绿。
 * 2. 回执里的 writes **不被信任**。本脚本自己 stat 每个 allowed 文件，
 *    只有 mtime 晚于 inbox 创建时间才算一次 fs.write —— 防止「写个回执说改了」。
 * 3. 输出的 run_report 是**等价构造**，不是真 SSE。所以 `toolCallCount` 只反映
 *    落盘事实，不反映 token 用量；账本会标 `actor=workbuddy-session`，
 *    这种轮次不能和「被衡量模型」的能力统计混在一起。
 * 4. 一次性 nonce：防止上一轮的旧回执被下一轮误读。
 * 5. 有超时，不无限等。超时输出 BRIDGE_ABORTED，循环据此停机，不归因、不记账。
 *
 * 用法：
 *   npx tsx scripts/dispatch-bridge.ts --task=<id> [--attempt=1] [--feedback-file=...] --wait
 *   npx tsx scripts/dispatch-bridge.ts --task=<id>            # 只导出任务书
 *   npx tsx scripts/dispatch-bridge.ts --status                # 列待办 inbox
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('..', import.meta.url));
const ROOT = path.join(SERVER, '..');
const BRIDGE = path.join(ROOT, '.self-upgrade', 'loop', 'bridge');
const INBOX = path.join(BRIDGE, 'inbox');
const OUTBOX = path.join(BRIDGE, 'outbox');
const TASKS = path.join(SERVER, 'self-upgrade', 'tasks.json');

const arg = (k: string): string | undefined =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? '').slice(`--${k}=`.length) || undefined;
const has = (k: string): boolean => process.argv.includes(`--${k}`);

interface TaskSpec {
  id: string;
  title?: string;
  allowed: string[];
  judge: string;
  package?: 'server' | 'client';
  gap?: string;
  observable?: string;
}

interface Inbox {
  nonce: string;
  task: string;
  attempt: number;
  taskbook: string;
  feedback: string;
  allowed: string[];
  /** 绝对路径：会话直接照这个改，不用再猜基准目录。 */
  writeHere: string[];
  judge: string;
  sandboxRoot: string;
  createdAt: string;
  replyTo: string;
}

function readSpec(id: string): TaskSpec {
  const j = JSON.parse(readFileSync(TASKS, 'utf8')) as { tasks: TaskSpec[] };
  const spec = j.tasks.find((t) => t.id === id);
  if (!spec) throw new Error(`tasks.json 里没有题目：${id}`);
  return spec;
}

/** allowed 的绝对路径。client 题是相对 client/ 的，server 题是相对 server/ 的。 */
function absOf(spec: TaskSpec, f: string): string {
  const x = f.replace(/\\/g, '/');
  if (spec.package === 'client') return path.join(ROOT, 'client', x);
  if (x.startsWith('client/')) return path.join(ROOT, x);
  if (x.startsWith('../client/')) return path.join(ROOT, x.slice(3));
  return path.join(SERVER, x);
}

/** 任务书从派单脚本拿（同一份文本，不在这里再抄一遍）。 */
function taskbookOf(id: string, feedbackFile?: string): string {
  const args = ['tsx', 'scripts/task-self-upgrade.ts', `--task=${id}`, '--print'];
  if (feedbackFile) args.push(`--feedback-file=${feedbackFile}`);
  return execFileSync('npx', args, {
    cwd: SERVER,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 120_000,
  });
}

function status(): void {
  if (!existsSync(INBOX)) {
    console.log('（桥接目录还没有任务书）');
    return;
  }
  const files = readdirSync(INBOX).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('（没有待办 inbox）');
    return;
  }
  for (const f of files) {
    const b = JSON.parse(readFileSync(path.join(INBOX, f), 'utf8')) as Inbox;
    const done = existsSync(path.join(OUTBOX, `${b.nonce}.json`));
    console.log(`${done ? '[已回执]' : '[待处理]'} ${b.task} #${b.attempt}  nonce=${b.nonce}`);
    console.log(`  写回 ${path.join(OUTBOX, `${b.nonce}.json`)}`);
  }
}

async function main(): Promise<void> {
  if (has('status')) {
    status();
    return;
  }

  const task = arg('task');
  if (!task) throw new Error('缺 --task=<id>');
  const attempt = Number(arg('attempt') ?? 1);
  const feedbackFile = arg('feedback-file');
  const feedback = feedbackFile && existsSync(feedbackFile) ? readFileSync(feedbackFile, 'utf8') : '';

  const spec = readSpec(task);
  const nonce = randomUUID();
  mkdirSync(INBOX, { recursive: true });
  mkdirSync(OUTBOX, { recursive: true });

  const box: Inbox = {
    nonce,
    task,
    attempt,
    taskbook: taskbookOf(task, feedbackFile),
    feedback,
    allowed: spec.allowed,
    writeHere: spec.allowed.map((f) => absOf(spec, f)),
    judge: spec.judge,
    sandboxRoot: spec.package === 'client' ? path.join(ROOT, 'client') : SERVER,
    createdAt: new Date().toISOString(),
    replyTo: path.join(OUTBOX, `${nonce}.json`),
  };
  const boxFile = path.join(INBOX, `${task}-${attempt}-${nonce.slice(0, 8)}.json`);
  writeFileSync(boxFile, JSON.stringify(box, null, 2) + '\n', 'utf8');

  console.log(`BRIDGE_INBOX=${boxFile}`);
  console.log(`BRIDGE_NONCE=${nonce}`);
  if (!has('wait')) {
    console.log('（只导出任务书；加 --wait 会等回执）');
    return;
  }

  const timeoutMs = Number(process.env.RSI_BRIDGE_TIMEOUT_MS ?? 540_000);
  const createdMs = Date.now();
  const replyFile = path.join(OUTBOX, `${nonce}.json`);
  console.log(`等待会话回执：${replyFile}（上限 ${Math.round(timeoutMs / 60_000)} 分钟）…`);

  let replied = false;
  while (Date.now() - createdMs < timeoutMs) {
    if (existsSync(replyFile)) {
      replied = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!replied) {
    console.log('BRIDGE_ABORTED=timeout：会话没有在时限内写回执。停机，不归因、不计入 Agent。');
    process.exitCode = 2;
    return;
  }

  // 回执只认 nonce；内容（writes/note）不作为事实来源。
  let reply: { nonce?: string; note?: string } = {};
  try {
    reply = JSON.parse(readFileSync(replyFile, 'utf8')) as { nonce?: string; note?: string };
  } catch {
    console.log('BRIDGE_ABORTED=bad-reply：回执不是合法 JSON');
    process.exitCode = 2;
    return;
  }
  if (reply.nonce !== nonce) {
    console.log('BRIDGE_ABORTED=nonce-mismatch：回执属于另一轮，拒绝串轮');
    process.exitCode = 2;
    return;
  }

  // 自己核对磁盘：只有 mtime 晚于 inbox 创建、且真实存在的 allowed 文件才算写入。
  const writes = box.writeHere.filter((f) => {
    if (!existsSync(f)) return false;
    try {
      return statSync(f).mtimeMs >= createdMs - 1000;
    } catch {
      return false;
    }
  });
  const calls = [...writes.map(() => 'fs.write'), ...box.writeHere.map(() => 'fs.read')];

  // 产出与 /api/v1/agent/stream 等价的 SSE 文本，让归因、诊断、账本照常工作。
  // 注意 tool_call 的 data 必须紧跟 `{`，failure-attribution 的正则按这个形状抠工具名。
  const lines: string[] = [];
  for (const [i, name] of calls.entries()) {
    lines.push('event: tool_call');
    lines.push(`data: {"callId":"bridge-${i}","name":"${name}"}`);
    lines.push('');
  }
  lines.push('event: run_report');
  lines.push(
    `data: ${JSON.stringify({
      runId: nonce,
      outcome: 'completed',
      statusCode: 'RUN_COMPLETED',
      hasMaterialChange: writes.length > 0,
      fileChangeCount: writes.length,
      actor: 'workbuddy-session',
      note: reply.note ?? '',
    })}`,
  );
  lines.push('');
  lines.push('event: done');
  lines.push(
    `data: ${JSON.stringify({
      finishReason: 'stop',
      iteration: 1,
      toolCallCount: calls.length,
      usage: { promptTokens: 0, completionTokens: 0 },
      tokenBudget: 0,
      actor: 'workbuddy-session',
    })}`,
  );
  lines.push('');
  const out = lines.join('\n');

  const dump = arg('sse-dump');
  if (dump) writeFileSync(dump, out, 'utf8');
  console.log(out);
  console.log(`BRIDGE_ACTOR=workbuddy-session`);
  console.log(`BRIDGE_WRITES=${writes.length}`);
}

main().catch((e) => {
  console.error(`BRIDGE_ABORTED=error：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
});
