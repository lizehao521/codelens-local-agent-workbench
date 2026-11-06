#!/usr/bin/env node
/**
 * 生成 RELEASE-MANIFEST.json（C-02）。
 *
 * 在 electron-builder 出包后调用：对最新 `CodeLens-Setup-*.exe` 计算字节数与 SHA256，
 * 连同 electron / electron-builder / node 版本、git 短哈希、构建时间，写入
 * `<输出目录>/RELEASE-MANIFEST.json`。文档与交付说明只引用该文件，不再手写安装包数值，
 * 避免出现「文档写 123.6MB、实际 129MB」之类的漂移。
 *
 * 导出 `writeReleaseManifest` 供 build-desktop.mjs 调用；直接运行本文件用于手工校验。
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 解析 electron-builder.yml 的 directories.output；解析失败回退 desktop/release。 */
export function resolveOutputDir(desktopDir) {
  try {
    const yml = readFileSync(path.join(desktopDir, 'electron-builder.yml'), 'utf8');
    const m = /^\s*output:\s*(.+?)\s*$/m.exec(yml);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* fallthrough */
  }
  return path.join(desktopDir, 'release');
}

function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

function safeJsonVersion(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).version ?? '';
  } catch {
    return '';
  }
}

function shortGitHash(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null; // 仓库未初始化 git（当前环境即如此）
  }
}

export function writeReleaseManifest({ desktopDir, repoRoot }) {
  const releaseDir = resolveOutputDir(desktopDir);
  if (!existsSync(releaseDir)) {
    console.warn(`[release-manifest] 输出目录不存在：${releaseDir}，跳过。`);
    return null;
  }
  const installers = readdirSync(releaseDir)
    .filter((f) => f.startsWith('CodeLens-Setup-') && f.endsWith('.exe'))
    .map((name) => {
      const full = path.join(releaseDir, name);
      return { name, full, mtime: statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (installers.length === 0) {
    console.warn('[release-manifest] 未找到 CodeLens-Setup-*.exe，跳过。');
    return null;
  }
  const installer = installers[0];
  const desktopPkg = safeJsonVersion(path.join(desktopDir, 'package.json')) || null;
  const manifest = {
    product: 'CodeLens',
    version: desktopPkg,
    generatedAt: new Date().toISOString(),
    git: shortGitHash(repoRoot),
    runtime: {
      node: process.versions.node,
      electron: safeJsonVersion(path.join(desktopDir, 'node_modules', 'electron', 'package.json')) || null,
      electronBuilder: safeJsonVersion(path.join(desktopDir, 'node_modules', 'electron-builder', 'package.json')) || null,
      platform: process.platform,
      arch: process.arch,
    },
    installer: {
      name: installer.name,
      bytes: statSync(installer.full).size,
      sha256: sha256File(installer.full),
    },
  };
  const out = path.join(releaseDir, 'RELEASE-MANIFEST.json');
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[release-manifest] 已写入 ${out}`);
  return { out, manifest };
}

// 直接运行：node scripts/release-manifest.mjs
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = writeReleaseManifest({ desktopDir: path.join(repoRoot, 'desktop'), repoRoot });
  process.exitCode = result ? 0 : 1;
}
