#!/usr/bin/env node
/**
 * 准备离线 Electron 镜像，供 build-desktop-offline.mjs 使用。
 *
 * 优先从 @electron/get 缓存（%LOCALAPPDATA%/electron/Cache）复用已下载的官方
 * Electron 压缩包；找不到则经直连（绕过代理）从 npmmirror 下载。最后生成
 * SHASUMS256.txt 供 @electron/get 校验。
 *
 * 用法：node scripts/prepare-electron-mirror.mjs
 */
import { existsSync, mkdirSync, copyFileSync, createReadStream, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '45.0.0';
const platform = 'win32';
const arch = 'x64';
const fileName = `electron-v${version}-${platform}-${arch}.zip`;
const targetDir = path.join(repoRoot, 'desktop', '.electron-mirror', `v${version}`);
const targetZip = path.join(targetDir, fileName);
const targetSha = path.join(targetDir, 'SHASUMS256.txt');

mkdirSync(targetDir, { recursive: true });

if (existsSync(targetZip) && statSync(targetZip).size > 1_000_000) {
  console.log(`已存在：${targetZip}`);
} else {
  // 1) 尝试从 @electron/get 缓存复用
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || path.join(process.env.HOME || '.', '.cache'),
    'electron',
    'Cache',
  );
  let found = null;
  if (existsSync(cacheRoot)) {
    for (const dir of require('node:fs').readdirSync(cacheRoot)) {
      const candidate = path.join(cacheRoot, dir, fileName);
      if (existsSync(candidate)) { found = candidate; break; }
    }
  }
  if (found) {
    console.log(`从 @electron/get 缓存复用：${found}`);
    copyFileSync(found, targetZip);
  } else {
    // 2) 直连 npmmirror 下载（绕过代理）
    const url = `https://registry.npmmirror.com/-/binary/electron/v${version}/${fileName}`;
    console.log(`下载：${url}`);
    const noProxy = 'localhost,127.0.0.1,registry.npmmirror.com,cdn.npmmirror.com';
    execFileSync('curl', ['-sL', '--noproxy', noProxy, '--max-time', '600', '-o', targetZip, url], {
      stdio: 'inherit',
    });
  }
}

// 生成 SHASUMS256.txt
// 注意：必须用「*」二进制格式（hash *filename），而非两空格文本格式。
// sumchecker 对两空格文本模式会用 utf8 编码读取二进制 zip，导致哈希损坏、
// 报 "Generated checksum did not match expected checksum"。electron 官方
// SHASUMS256.txt 即采用 * 二进制格式。
const crypto = await import('node:crypto');
const h = crypto.createHash('sha256');
await new Promise((resolve, reject) => {
  createReadStream(targetZip)
    .pipe(h)
    .on('finish', resolve)
    .on('error', reject);
});
const digest = h.digest('hex');
writeFileSync(targetSha, `${digest} *${fileName}\n`);
console.log(`SHA256: ${digest}`);
console.log(`已写入：${targetSha}`);
