#!/usr/bin/env node
/**
 * CodeLens 桌面安装包一键构建。
 *
 * 步骤：
 *   1. 构建客户端（vite）与服务端（tsc），同步静态产物到 server/dist-client
 *   2. esbuild 把服务端打成 desktop/server-bundle.cjs
 *   3. 生成应用图标 desktop/build/icon.png
 *   4. electron-builder 出 Windows x64 NSIS 安装包
 *
 * 用法：
 *   node scripts/build-desktop.mjs                # 全量构建
 *   node scripts/build-desktop.mjs --skip-app-build # 复用已有前后端产物
 *   node scripts/build-desktop.mjs --dir          # 只出未打包目录（快速验证）
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReleaseManifest, resolveOutputDir } from './release-manifest.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(repoRoot, 'desktop');

const args = process.argv.slice(2);
const skipAppBuild = args.includes('--skip-app-build');
const dirOnly = args.includes('--dir');

// ---------------------------------------------------------------------------
// 网络加固（国内环境常见坑）
//   1) 默认走 npmmirror 二进制镜像，避免 GitHub 直连不稳/被墙。
//   2) 若本机/沙箱配置了 HTTP 代理，镜像主机必须加入 NO_PROXY，否则
//      electron-builder 经代理请求 npmmirror 会挂到 10 分钟超时（实测踩过）。
//   用户已显式设置 ELECTRON_BUILDER_BINARIES_MIRROR 时尊重其选择。
// ---------------------------------------------------------------------------
const MIRROR_HOSTS = ['registry.npmmirror.com', 'cdn.npmmirror.com', 'npmmirror.com'];
if (!process.env.ELECTRON_BUILDER_BINARIES_MIRROR) {
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
    'https://registry.npmmirror.com/-/binary/electron-builder-binaries/';
}
// 网络加固策略（踩坑总结）：
//   - 保留系统/沙箱 HTTP 代理：Electron 二进制经代理可达 GitHub，能正常下载/校验。
//   - 对 npmmirror 等镜像主机加入 NO_PROXY：本机代理无法直连 npmmirror（返回 502），
//     若 electron-builder 真的去拉镜像，需绕过代理。
//   - NSIS / winCodeSign 二进制已预置到 electron-builder 归档缓存（见 docs），命中即跳过下载，
//     因此构建全程不再触碰外网镜像，避免任何代理/镜像不稳定问题。
for (const key of ['NO_PROXY', 'no_proxy']) {
  const existing = process.env[key] ? process.env[key].split(',').map((s) => s.trim()) : [];
  const merged = Array.from(new Set([...existing, ...MIRROR_HOSTS])).join(',');
  process.env[key] = merged;
}
// 没有代码签名证书时，关闭自动发现，避免 electron-builder 扫描/等待证书。
if (!process.env.CSC_LINK && !process.env.CSC_IDENTITY_AUTO_DISCOVERY) {
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}

function run(command, commandArgs, cwd = repoRoot) {
  console.log(`\n▶ ${command} ${commandArgs.join(' ')}`);
  execFileSync(command, commandArgs, { cwd, stdio: 'inherit', shell: true });
}

function ensureExists(file, hint) {
  if (!existsSync(file)) {
    console.error(`缺少 ${file}${hint ? ` — ${hint}` : ''}`);
    process.exit(1);
  }
}

if (!skipAppBuild) {
  console.log('== 1/4 构建前后端产物 ==');
  run('npm', ['run', 'build', '--prefix', 'client']);
  run('npm', ['run', 'build', '--prefix', 'server']);
  run('node', [path.join('scripts', 'prepare-dist.mjs')]);
} else {
  console.log('== 1/4 跳过前后端构建（--skip-app-build）==');
}
ensureExists(path.join(repoRoot, 'server', 'dist', 'app.js'), '先构建服务端（npm run build --prefix server）');
ensureExists(path.join(repoRoot, 'server', 'dist-client', 'index.html'), '先执行 scripts/prepare-dist.mjs');

console.log('\n== 2/4 打包服务端单文件 ==');
run('node', [path.join('desktop', 'scripts', 'bundle-server.mjs')]);
ensureExists(path.join(desktopDir, 'server-bundle.cjs'));

console.log('\n== 3/4 生成应用图标 ==');
run('node', [path.join('desktop', 'scripts', 'gen-icon.mjs')]);
ensureExists(path.join(desktopDir, 'build', 'icon.png'));

console.log('\n== 4/4 electron-builder 打包 ==');
const builderCli = path.join(desktopDir, 'node_modules', 'electron-builder', 'cli.js');
const builderBin = path.join(desktopDir, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
const builderArgs = ['--win', '--x64', ...(dirOnly ? ['--dir'] : [])];
// 注意：仓库路径含空格（如 "新建文件夹 (2)"），用 shell:false 以 argv 数组传参，
// 避免 cmd 把带空格的绝对路径截断成 "Cannot find module"。
try {
  if (existsSync(builderCli)) {
    console.log(`▶ ${process.execPath} ${builderCli} ${builderArgs.join(' ')}`);
    execFileSync(process.execPath, [builderCli, ...builderArgs], {
      cwd: desktopDir,
      stdio: 'inherit',
      shell: false,
    });
  } else {
    ensureExists(builderBin, '先在 desktop/ 执行 npm install');
    console.log(`▶ ${builderBin} ${builderArgs.join(' ')}`);
    execFileSync(builderBin, builderArgs, { cwd: desktopDir, stdio: 'inherit', shell: false });
  }
} catch (err) {
  console.error('electron-builder 打包失败：', err.message);
  process.exit(1);
}

console.log('\n== 5/4 生成 RELEASE-MANIFEST ==');
try {
  writeReleaseManifest({ desktopDir, repoRoot });
} catch (err) {
  console.warn('[release-manifest] 生成失败（不阻断构建）：', err.message);
}

console.log(`\n桌面构建完成。产物目录：${resolveOutputDir(desktopDir)}`
  + '（desktop/electron-builder.yml 的 directories.output）');
