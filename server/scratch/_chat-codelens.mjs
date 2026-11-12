// 与本机 CodeLens(8080) 进行只读开发对话的驱动脚本。
// 用法: node scratch/_chat-codelens.mjs <message-file> [sessionId]
// 密钥从 server/.env 本地读取，不打印；rsiMeasure=false 不污染代际测量；
// 工具白名单仅 fs.read/fs.list（机械只读，不靠提示词约束）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const envPath = new URL('../.env', import.meta.url);
if (existsSync(envPath)) process.loadEnvFile(envPath);

const BASE = process.env.CHAT_BASE ?? 'http://127.0.0.1:8080';
const [msgFile, sessionId] = process.argv.slice(2);
if (!msgFile) {
  console.error('usage: node _chat-codelens.mjs <message-file> [sessionId]');
  process.exit(1);
}

const apiKey = process.env.RSI_API_KEY ?? process.env.LLM_SERVER_API_KEY ?? '';
const customBaseUrl = process.env.RSI_BASE_URL ?? process.env.TRIAL_BASE_URL ?? '';
if (!apiKey || !customBaseUrl) {
  console.error('missing upstream config: need RSI_API_KEY/LLM_SERVER_API_KEY and RSI_BASE_URL/TRIAL_BASE_URL in server/.env');
  process.exit(1);
}

const body = {
  provider: 'custom',
  model: process.env.CHAT_MODEL ?? 'nemotron-3-ultra-550b-a55b',
  customBaseUrl,
  apiKey,
  channelMode: 'native',
  maxTokens: 8192,
  maxIterations: Number(process.env.CHAT_MAX_ITERATIONS ?? 8),
  temperature: 0.3,
  rsiMeasure: false,
  tools: ['fs.read', 'fs.list'],
  message: readFileSync(msgFile, 'utf8'),
};
if (sessionId) body.sessionId = sessionId;

const res = await fetch(`${BASE}/api/v1/agent/stream`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(300_000),
});
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  process.exit(1);
}

const raw = await res.text();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const ssePath = new URL(`./_chat-sse-${stamp}.txt`, import.meta.url);
writeFileSync(ssePath, raw, 'utf8');

let event = '';
let text = '';
let sid = sessionId ?? '';
let report = null;
let done = null;
let errors = [];
for (const line of raw.split('\n')) {
  if (line.startsWith('event: ')) { event = line.slice(7).trim(); continue; }
  if (!line.startsWith('data: ')) continue;
  let j;
  try { j = JSON.parse(line.slice(6)); } catch { continue; }
  if (event === 'meta' && j.sessionId) sid = j.sessionId;
  else if (event === 'delta' && typeof j.text === 'string') text += j.text;
  else if (event === 'run_report') report = j;
  else if (event === 'done') done = j;
  else if (event === 'error') errors.push(j);
}

console.log(`SESSION: ${sid}`);
console.log(`SSE存档: ${ssePath.pathname.replace(/^\//, '')}`);
if (report) {
  console.log(`REPORT: outcome=${report.outcome} tools=${report.toolCallCount} files=${report.fileChangeCount} tokens=${(report.promptTokens ?? 0) + (report.completionTokens ?? 0)} durationMs=${report.durationMs} triggers=${JSON.stringify(report.triggers)}`);
}
if (done) console.log(`DONE: finishReason=${done.finishReason} iteration=${done.iteration}`);
if (errors.length) console.log(`ERRORS: ${JSON.stringify(errors).slice(0, 800)}`);
console.log('---- ANSWER ----');
console.log(text || '(空输出)');