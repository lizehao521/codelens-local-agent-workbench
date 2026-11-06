#!/usr/bin/env node
/**
 * CodeLens 桌面安装包「离线」构建。
 *
 * 适用场景：构建机处于受限网络（如沙箱/代理无法直连 GitHub 与 npmmirror、
 * 或直连不稳），electron-builder 拉取 Electron 二进制会卡死/超时。
 *
 * 做法：
 *   1. 在 127.0.0.1 起一个静态服务，仅服务本地已备好的 Electron 镜像
 *      （desktop/.electron-mirror，含官方 electron 压缩包 + 自签 SHASUMS256.txt）。
 *   2. 把 ELECTRON_MIRROR 指向本机服务，并对 127.0.0.1 加入 NO_PROXY，
 *      让 Electron 走本机直连、零外网。
 *   3. NSIS / winCodeSign 二进制已预置到 electron-builder 归档缓存，同样零外网。
 *   4. 调起 build-desktop.mjs 出包；构建结束后关闭本地服务。
 *
 * 前置：先运行 scripts/prepare-electron-mirror.mjs 生成 desktop/.electron-mirror。
 * 用法：node scripts/build-desktop-offline.mjs [--skip-app-build] [--dir]
 */

import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mirrorDir = path.join(repoRoot, 'desktop', '.electron-mirror');

const args = process.argv.slice(2);
const skipAppBuild = args.includes('--skip-app-build');
const dirOnly = args.includes('--dir');

if (!existsSync(mirrorDir)) {
  console.error(`缺少本地 Electron 镜像目录：${mirrorDir}\n请先运行 node scripts/prepare-electron-mirror.mjs`);
  process.exit(1);
}

const PORT = 8731;
const server = createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const filePath = path.join(mirrorDir, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(mirrorDir) || !existsSync(filePath)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
      createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`▶ local electron mirror server on http://127.0.0.1:${PORT}/`);
});
server.on('error', (err) => {
  console.error(`本地镜像服务启动失败（端口 ${PORT} 可能已被占用）：`, err.message);
  process.exit(1);
});

// 让 Electron 走本机镜像，并彻底清除代理环境变量。
// 说明：@electron/get 不会按 NO_PROXY 把 127.0.0.1 请求绕过代理，localhost 请求会被
// 塞给本地代理（HTTP_PROXY=127.0.0.1:1504）导致 502。离线构建本就零外网（仅本机
// 镜像 + 归档缓存），故直接删除代理变量，让所有请求走直连。
process.env.ELECTRON_MIRROR = `http://127.0.0.1:${PORT}/`;
for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) {
  delete process.env[key];
}
// 让 signtool 不做「时间戳」联网校验：默认会加 /tr http://timestamp.digicert.com 与
// /td sha256，在无外网/代理不可达时会长时间挂起，导致 NSIS 安装包始终打不出来。
// 该变量仅影响签名的时间戳参数，不影响任何二进制下载（已核对源码）。
process.env.ELECTRON_BUILDER_OFFLINE = 'true';

const builderArgs = ['scripts/build-desktop.mjs', '--skip-app-build', ...(dirOnly ? ['--dir'] : [])];
// 注意：必须用异步 spawn，不能用 execFileSync —— 后者会阻塞父进程事件循环，
// 导致内嵌的本地镜像 HTTP 服务无法接受 electron-builder 的连接（ECONNREFUSED）。
const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, builderArgs, { cwd: repoRoot, stdio: 'inherit', shell: false });
  child.on('exit', (exitCode) => {
    try { server.close(); } catch { /* noop */ }
    resolve(exitCode ?? 1);
  });
  child.on('error', (err) => {
    console.error('启动构建子进程失败：', err.message);
    try { server.close(); } catch { /* noop */ }
    resolve(1);
  });
});
if (code === 0) {
  console.log('\n离线桌面构建完成。产物目录：C:/codelens-build/release'
    + '（desktop/electron-builder.yml 的 directories.output）');
} else {
  console.error(`\n桌面构建失败（exit ${code}）。`);
}
process.exit(code);
