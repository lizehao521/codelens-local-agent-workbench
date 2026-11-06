#!/usr/bin/env node
/**
 * 服务端单文件包（server-bundle.cjs）烟测。
 *
 * 验证 esbuild 打包没有破坏运行时行为（动态依赖、node:sqlite、MCP 子进程）：
 *   1. /api/health            → 200 且 db.ok
 *   2. /api/v1/tools          → 双轨工具名（http.request + http_request）
 *   3. SSE 无 Key             → error 事件 MISSING_API_KEY
 *   4. SPA                   → / 与深链均返回 index.html
 *   5. MCP 连接器             → 创建/连接/注册双轨名/断开即消失
 *
 * 用法：
 *   node scripts/smoke-server-bundle.mjs            # 用系统 node 跑
 *   RUNNER=electron node scripts/smoke-server-bundle.mjs   # 用 Electron 的 node 跑
 *   （Electron 的 node 版本决定 node:sqlite 是否可用，这一步是关键验证）
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(repoRoot, 'desktop');
const bundle = path.join(desktopDir, 'server-bundle.cjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS: ${name}`);
  } else {
    failed++;
    console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const port = await freePort();
const tmp = mkdtempSync(path.join(tmpdir(), 'codelens-smoke-'));
const sandbox = path.join(tmp, 'sandbox');
const dbPath = path.join(tmp, 'smoke.db');

const runner = process.env.RUNNER === 'electron'
  ? path.join(desktopDir, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  : process.execPath;

const env = {
  ...process.env,
  NODE_ENV: 'production',
  CODELENS_PORT: String(port),
  AGENT_DB_PATH: dbPath,
  SANDBOX_ROOT: sandbox,
  MCP_CONFIG_PATH: path.join(tmp, 'mcp-servers.json'),
  CLIENT_DIST_DIR: path.join(repoRoot, 'server', 'dist-client'),
  AGENT_APPROVAL_SECRET: 'smoke-secret-'.repeat(4),
};
if (process.env.RUNNER === 'electron') env.ELECTRON_RUN_AS_NODE = '1';

// 入口：起服务并等待 listening
const entry = path.join(tmp, 'entry.cjs');
const { writeFileSync } = await import('node:fs');
writeFileSync(
  entry,
  `const { createApp } = require(${JSON.stringify(bundle)});
const app = createApp();
app.listen(${port}, '127.0.0.1', () => console.log('SMOKE_LISTENING'));
`,
  'utf8',
);

const child = spawn(runner, process.env.RUNNER === 'electron' ? [entry] : [entry], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
child.stdout.on('data', (d) => {
  stdout += d;
});
let stderr = '';
child.stderr.on('data', (d) => {
  stderr += d;
});

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stdout.includes('SMOKE_LISTENING')) return true;
    if (child.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function cleanup() {
  try {
    child.kill();
  } catch {
    /* 已退出 */
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
}

process.on('exit', cleanup);

const BASE = `http://127.0.0.1:${port}`;
const nodeExe = process.execPath;

try {
  const up = await waitForServer();
  check('服务端单文件包启动（SMOKE_LISTENING）', up, stderr.slice(0, 400));
  if (!up) throw new Error('server did not start');

  // 1. health
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check('health 200 且 db.ok', health?.db?.ok === true, JSON.stringify(health).slice(0, 200));

  // 2. 双轨工具名
  const tools = await (await fetch(`${BASE}/api/v1/tools`)).json();
  const names = (tools?.tools ?? []).map((t) => t.name);
  const wireNames = (tools?.tools ?? []).map((t) => t.wireName);
  check('tools 含点号规范名 http.request', names.includes('http.request'));
  check('tools 含下划线线上名 http_request', wireNames.includes('http_request'));

  // 3. SSE 无 Key
  const sse = await fetch(`${BASE}/api/v1/agent/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'deepseek', model: 'deepseek-v4-pro', message: '读文件' }),
  });
  const sseText = await sse.text();
  check('SSE 无 Key → MISSING_API_KEY 错误帧', sse.status === 200 && sseText.includes('MISSING_API_KEY'));

  // 4. SPA
  const index = await (await fetch(`${BASE}/`)).text();
  check('根路径返回 index.html', index.includes('<div id="root">') || index.includes('id="root"'));
  const deep = await (await fetch(`${BASE}/settings/tools`)).text();
  check('深链走 SPA fallback', deep.includes('id="root"'));

  // 5. MCP 连接器
  const fixture = path.join(repoRoot, 'server', 'tests', 'fixtures', 'fake-mcp-server.mjs').replace(/\\/g, '/');
  const nodeArg = nodeExe.replace(/\\/g, '/');
  const created = await fetch(`${BASE}/api/v1/mcp/servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Smoke Fake',
      command: nodeArg,
      args: [fixture],
      env: { SMOKE_KEY: 'x' },
    }),
  });
  const createdBody = await created.json().catch(() => null);
  check('MCP 创建 201', created.status === 201, JSON.stringify(createdBody).slice(0, 200));
  const serverId = createdBody?.server?.id ?? 'smoke-fake';

  const connected = await fetch(`${BASE}/api/v1/mcp/servers/${serverId}/connect`, { method: 'POST' });
  const connectBody = await connected.json().catch(() => null);
  check('MCP 连接成功', connected.status === 200 && connectBody?.server?.status === 'connected',
    JSON.stringify(connectBody).slice(0, 300));

  const toolsAfter = await (await fetch(`${BASE}/api/v1/tools`)).json();
  const namesAfter = (toolsAfter?.tools ?? []).map((t) => t.name);
  const wireAfter = (toolsAfter?.tools ?? []).map((t) => t.wireName);
  check('MCP 工具注册双轨名', namesAfter.includes(`mcp.${serverId}.echo`) && wireAfter.includes(`mcp_${serverId}_echo`),
    namesAfter.filter((n) => n.startsWith('mcp.')).join(','));

  const disconnected = await fetch(`${BASE}/api/v1/mcp/servers/${serverId}/disconnect`, { method: 'POST' });
  check('MCP 断开 200', disconnected.status === 200);
  const toolsFinal = await (await fetch(`${BASE}/api/v1/tools`)).json();
  const namesFinal = (toolsFinal?.tools ?? []).map((t) => t.name);
  check('MCP 断开后工具消失', !namesFinal.some((n) => n.startsWith('mcp.')));

  console.log(`\nnode: ${process.version}${process.env.RUNNER === 'electron' ? ' (electron)' : ''}`);
  console.log(`smoke: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
} catch (err) {
  console.error('smoke error:', err);
  console.error('stderr:', stderr.slice(0, 800));
  process.exitCode = 1;
} finally {
  cleanup();
}
