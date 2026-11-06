#!/usr/bin/env node
/**
 * 把服务端构建产物打成单个 CJS 文件，供 Electron 主进程 require。
 *
 * 入口：server/dist/app.js（tsc 产物，ESM）
 * 输出：desktop/server-bundle.cjs（node: 内建模块自动 external）
 *
 * 为什么必须 CJS 而不是 ESM：ESM 输出会把 CJS 依赖（express→body-parser→debug）
 * 里的 require('tty')/require('util') 改写成必抛的 __require（esbuild 已知限制），
 * 打包产物在 import 时直接崩。CJS 输出保留原生 require，内置模块正常工作。
 *
 * 代价：import.meta.url 在 CJS 产物中为空。服务端 env.ts 与
 * mcp-config.store.ts 已对该场景加 try/catch 兜底（桌面态所有路径均由 env 覆盖）。
 *
 * 注意：config/env.ts 在模块顶层读取 process.env —— Electron 主进程
 * 已在 require 本文件之前设置好全部 env，顺序不能反。
 */

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(desktopDir, '..');
const entry = path.join(repoRoot, 'server', 'dist', 'app.js');
const outfile = path.join(desktopDir, 'server-bundle.cjs');

mkdirSync(desktopDir, { recursive: true });

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
  metafile: true,
  // express 等纯 JS 依赖全部打进去；node:* 由 platform=node 自动 external。
  // 若未来出现运行时 require 解析失败的依赖，在此显式 external。
  external: ['electron'],
});

const outputs = Object.entries(result.metafile.outputs).map(([file, info]) => ({
  file: path.basename(file),
  bytes: info.bytes,
}));
for (const out of outputs) {
  console.log(`bundled: ${out.file} (${(out.bytes / 1024).toFixed(0)} KB)`);
}
if (result.warnings.length > 0) {
  console.log(`warnings: ${result.warnings.length}（见上方输出）`);
}
