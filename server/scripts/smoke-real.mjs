#!/usr/bin/env node
/**
 * 端到端真实验证：让本产品的 Agent 在一个真实任务上跑一遍，输出「是否收敛」的证据。
 *
 * 为什么需要它：全量测试（648 条）证明的是「每个零件对」，证明不了「装起来能干活」。
 * 这个脚本走真实 HTTP + 真实 SSE + 真实工具执行 + 真实审批流，只把 LLM 换成你配的那个，
 * 然后回答三个问题：
 *   1. 它收敛了吗（拿到最终答案，而不是耗尽轮次/被中止）
 *   2. 它用了哪些工具、顺序对不对
 *   3. 这次花了多少 token、判据塔怎么判的
 *
 * 用法（先起服务，另开一个终端）：
 *   cd server && npm run dev                     # 默认 3000 端口
 *   node scripts/smoke-real.mjs                  # 跑默认任务
 *   node scripts/smoke-real.mjs --task "读 package.json 并说明依赖"
 *   node scripts/smoke-real.mjs --auto-approve    # 自动批准（仅本地验证用）
 *
 * 需要服务端已配置可用的 provider（LLM_SERVER_API_KEY 或前端设置里填的 key），
 * 否则 upstream 会返回 401/404——脚本会把上游错误原样打出来，不掩盖。
 *
 * 退出码：0 收敛且无错误；1 未收敛或出现 error 事件。
 */

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const has = (name) => args.includes(`--${name}`);

const BASE = arg('base-url', process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8080');
const TASK = arg('task', '列出当前项目 server 目录下 src 里有哪些子目录，并说明每个大致做什么。先列目录，再挑两个读文件确认。');
const PROVIDER = arg('provider', process.env.SMOKE_PROVIDER);
const MODEL = arg('model', process.env.SMOKE_MODEL);
const MAX_WAIT_MS = Number(arg('timeout', '180000'));
const AUTO_APPROVE = has('auto-approve');
// key 优先从环境变量取：命令行参数会出现在进程列表里，不适合放密钥。
const API_KEY = process.env.SMOKE_API_KEY ?? arg('api-key', '');
const CUSTOM_BASE = arg('custom-base-url', process.env.SMOKE_CUSTOM_BASE_URL ?? '');
// auto 会先探测 native 能力，探测不过就降级 ReAct；排查时用这个强制指定通道。
const CHANNEL = arg('channel-mode', process.env.SMOKE_CHANNEL ?? 'auto');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

async function json(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** 极简 SSE 读取：按 `event:` / `data:` 两行一组切分。 */
async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      let payload = null;
      try {
        payload = JSON.parse(dataLines.join('\n'));
      } catch {
        payload = dataLines.join('\n');
      }
      onEvent(event, payload);
    }
  }
}

async function main() {
  console.log(c.bold('\nCodeLens 端到端验证'));
  console.log(c.dim(`  目标   ${BASE}`));
  console.log(c.dim(`  任务   ${TASK}`));
  console.log('');

  // 0) 先确认服务活着，避免把「没启动」误报成「跑不通」
  let health;
  try {
    health = await json('GET', '/api/health');
  } catch (err) {
    console.log(c.bad(`✗ 连不上 ${BASE}：${err.message}`));
    console.log(c.dim('  先启动服务：cd server && npm run dev'));
    process.exit(1);
  }
  console.log(`  服务状态 ${health.body?.status ?? '?'} · 版本 ${health.body?.version ?? '?'}`);

  // 没显式指定就取服务端第一个可用 provider/model —— 用户不用记模型名。
  // 注意这只代表「目录里有这个模型」，不代表有可用 key；没 key 时下游会报 401，
  // 脚本会把上游错误原样打出来。
  let provider = PROVIDER;
  let model = MODEL;
  if (!provider || !model) {
    const list = await json('GET', '/api/v1/providers');
    const first = list.body?.providers?.[0];
    provider = provider ?? first?.id;
    model = model ?? first?.models?.[0]?.id;
  }
  if (!provider || !model) {
    console.log(c.bad('✗ 服务端没有可用 provider/model，无法验证'));
    console.log(c.dim('  先用前端或在 config 里配置 provider，或显式传 --provider/--model'));
    process.exit(1);
  }

  // 1) 建会话
  const created = await json('POST', '/api/v1/sessions', { provider, model });
  if (created.status >= 300) {
    console.log(c.bad(`✗ 建会话失败 ${created.status}: ${JSON.stringify(created.body)}`));
    process.exit(1);
  }
  const session = created.body?.session ?? created.body;
  const sessionId = session?.id;
  console.log(c.dim(`  会话   ${sessionId} · ${session?.provider}/${session?.model}`));

  // 2) 发任务，读流
  const body = {
    sessionId,
    message: TASK,
    channelMode: CHANNEL,
    provider,
    model,
    ...(API_KEY ? { apiKey: API_KEY } : {}),
    ...(CUSTOM_BASE ? { customBaseUrl: CUSTOM_BASE } : {}),
  };

  const started = Date.now();
  const stats = {
    deltas: 0,
    answer: '',
    toolCalls: [],
    toolResults: [],
    approvals: 0,
    errors: [],
    done: null,
  };
  const toolNameById = new Map();

  const res = await fetch(`${BASE}/api/v1/agent/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.log(c.bad(`✗ 请求被拒 ${res.status}: ${text.slice(0, 400)}`));
    process.exit(1);
  }

  const timer = setTimeout(() => {
    console.log(c.warn(`\n⚠ 超过 ${MAX_WAIT_MS}ms 仍未结束，判定为未收敛`));
    process.exit(1);
  }, MAX_WAIT_MS);

  await readSse(res, (event, payload) => {
    if (event === 'delta' && payload?.text) {
      stats.deltas += 1;
      stats.answer += payload.text;
    } else if (event === 'tool_call') {
      const name = payload?.name ?? payload?.toolName ?? '?';
      toolNameById.set(payload?.id ?? payload?.callId, name);
      stats.toolCalls.push(name);
      console.log(c.dim(`  → ${name}`));
    } else if (event === 'tool_result') {
      stats.toolResults.push({ id: payload?.id, status: payload?.status });
      const name = toolNameById.get(payload?.id) ?? '';
      const mark = payload?.status === 'success' ? c.ok('✓') : c.bad('✗');
      console.log(c.dim(`  ← ${mark} ${name} ${payload?.status ?? ''}`));
    } else if (event === 'tool_approval_required') {
      stats.approvals += 1;
      const id = payload?.approvalId ?? payload?.id;
      console.log(c.warn(`  ⏸ 需要审批：${payload?.toolName ?? payload?.name ?? '?'}（id=${id}）`));
      if (AUTO_APPROVE && id) {
        // 本地验证才用；真实场景应由人确认——这条路径本身就是安全设计的一部分。
        void json('POST', `/api/v1/approvals/${id}`, { decision: 'approve' }).then((r) => {
          console.log(c.dim(`    自动批准 → ${r.status}`));
        });
      }
    } else if (event === 'done') {
      stats.done = payload;
    } else if (event === 'error') {
      stats.errors.push(payload);
      console.log(c.bad(`  ✗ error: ${JSON.stringify(payload).slice(0, 300)}`));
    }
  });
  clearTimeout(timer);

  const elapsed = Date.now() - started;

  // 3) 判据
  let judgment = null;
  const runs = await json('GET', `/api/v1/judge/runs?sessionId=${sessionId}&limit=1`);
  const latest = Array.isArray(runs.body?.runs) ? runs.body.runs[0] : undefined;
  if (latest) judgment = latest;

  // 4) 报告
  const ok = stats.errors.length === 0 && stats.done !== null && stats.answer.trim().length > 0;
  console.log('');
  console.log(c.bold('结果'));
  console.log(`  收敛      ${stats.done ? c.ok('是') : c.bad('否')}`);
  console.log(`  最终答案  ${stats.answer.trim().length} 字${stats.answer.trim() ? '' : c.bad('（空）')}`);
  console.log(`  工具调用  ${stats.toolCalls.length} 次：${stats.toolCalls.join(' → ') || '（无）'}`);
  console.log(`  审批      ${stats.approvals} 次${AUTO_APPROVE ? '（已自动批准）' : ''}`);
  if (stats.done?.usage) {
    const u = stats.done.usage;
    console.log(`  token     prompt ${u.promptTokens ?? '?'} / completion ${u.completionTokens ?? '?'}`);
  }
  if (judgment) {
    const coverage = typeof judgment.coverage === 'number' ? judgment.coverage.toFixed(2) : '?';
    console.log(`  判据      ${judgment.verdict}（覆盖率 ${coverage}）`);
  }
  console.log(`  耗时      ${(elapsed / 1000).toFixed(1)}s`);
  console.log('');

  if (stats.answer.trim()) {
    console.log(c.bold('答案摘要'));
    // 带 reasoning 的模型常在正文里夹成片空行，直接取前 12 行会显示成一片空白。
    // 先滤掉空行再截断，摘要才有信息量（实测 442 字答案前面全是空行）。
    const answerLines = stats.answer
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);
    console.log(answerLines.slice(0, 12).map((l) => `  ${l}`).join('\n'));
    if (answerLines.length > 12) console.log(c.dim(`  …（共 ${answerLines.length} 行）`));
    console.log('');
  }

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(c.bad(`\n✗ 脚本异常：${err?.stack ?? err}`));
  process.exit(1);
});
