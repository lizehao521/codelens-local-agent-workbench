#!/usr/bin/env node
'use strict';
/**
 * [master 部署入口] 加载最新源码构建产物 server/dist/app.js 并常驻监听 8080。
 *
 * 目的：消除版本漂移——使线上 8080 与 master 源码完全一致（含 /judge、
 * /sandbox-permissions，以及前端顶栏的「设置」按钮等）。
 * 旧一代 legacy 启动器（加载 C:/codelens-build/legacy/server-bundle.cjs，
 * 硬编码 version 2.0.1）已备份至 /tmp/serve-legacy.cjs.legacy-bak-* 。
 *
 * app.js 是 ESM，且 createApp() 本身不监听（监听仅在 isMainModule 分支）。
 * 本脚本以 CommonJS 运行，用动态 import() 加载 app.js 后自行 app.listen()。
 *
 * 用法：node scripts/serve-legacy.cjs
 * 可覆盖：PORT / HOST / CLIENT_DIST_DIR / AGENT_DB_PATH / SANDBOX_ROOT /
 *         AGENT_APPROVAL_SECRET / AUTO_MODEL_SYNC
 * 能力开关（默认开启，env 优先）：CHECKPOINT_ENABLED / OBSERVABILITY_ENABLED /
 *         SKILL_LIBRARY_ENABLED
 */
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const root = __dirname; // scripts/
const appJs = path.join(root, '..', 'server', 'dist', 'app.js');
const clientDist = path.join(root, '..', 'server', 'dist-client');

if (!fs.existsSync(appJs)) {
  console.error(`[serve-master] 缺少构建产物：${appJs}（请先 npm run build）`);
  process.exit(1);
}
if (!fs.existsSync(path.join(clientDist, 'index.html'))) {
  console.error(`[serve-master] 缺少前端产物：${clientDist}/index.html`);
  process.exit(1);
}

// config 模块在 app.js 顶层读取 process.env，必须在 import 之前全部就位。
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.PORT = process.env.PORT || '8080';
process.env.HOST = process.env.HOST || '127.0.0.1';
process.env.CLIENT_DIST_DIR = process.env.CLIENT_DIST_DIR || clientDist;
process.env.AGENT_DB_PATH = process.env.AGENT_DB_PATH || path.join(root, '..', 'server', 'data', 'codelens.db');
process.env.SANDBOX_ROOT = process.env.SANDBOX_ROOT || path.join(root, '..', 'server', 'workspace');
process.env.AGENT_APPROVAL_SECRET =
  process.env.AGENT_APPROVAL_SECRET || 'master-local-approval-secret';
// 能力开关（可观测面）：与桌面端 main.cjs 的注入口径一致 —— 默认开启，env 优先。
//   · CHECKPOINT_ENABLED    工作区快照 / 按 id 回滚（N8）
//   · OBSERVABILITY_ENABLED 运行轨迹埋点（T11）
//   · SKILL_LIBRARY_ENABLED 程序化技能库（N1）
// 必须在 import app.js 之前就位：server/src/config/env.ts 在模块顶层读取它们。
process.env.CHECKPOINT_ENABLED = process.env.CHECKPOINT_ENABLED ?? '1';
process.env.OBSERVABILITY_ENABLED = process.env.OBSERVABILITY_ENABLED ?? '1';
process.env.SKILL_LIBRARY_ENABLED = process.env.SKILL_LIBRARY_ENABLED ?? '1';
const autoStartModelSync = process.env.AUTO_MODEL_SYNC === '1' ||
  (process.env.AUTO_MODEL_SYNC !== '0' && process.env.NODE_ENV !== 'test');

fs.mkdirSync(path.dirname(process.env.AGENT_DB_PATH), { recursive: true });
fs.mkdirSync(process.env.SANDBOX_ROOT, { recursive: true });

(async () => {
  const { createApp } = await import(pathToFileURL(appJs).href);
  const app = createApp({ clientDistDir: clientDist, autoStartModelSync });
  const server = app.listen(Number(process.env.PORT), process.env.HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`codelens-master listening on ${process.env.HOST}:${process.env.PORT} (${process.env.NODE_ENV})`);
  });

  server.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[serve-master] listen error: ${err.code} ${err.message}`);
  });
  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[serve-master] uncaughtException:', err && err.stack);
  });
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[serve-master] unhandledRejection:', reason);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      // eslint-disable-next-line no-console
      console.log(`[serve-master] received ${sig}, shutting down`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
  process.on('exit', (code) => {
    // eslint-disable-next-line no-console
    console.log(`[serve-master] process exit, code=${code}, uptime=${Math.round(process.uptime())}s`);
  });
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[serve-master] 启动失败:', err && err.stack);
  process.exit(1);
});
