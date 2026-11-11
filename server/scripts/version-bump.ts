/**
 * version-bump.ts — 升版本号。
 *
 * ── 为什么独立成模块 ────────────────────────────────────────
 * 原来的实现写在 self-upgrade-loop.ts 里，用 `execFileSync('node', ['-e', <一大段内联 JS>])`
 * 来改文件。两个问题叠在一起，让它**一直静默失效**：
 *   1. Windows 下 `shell: true` 不转义参数，那一大段带引号换行的脚本被命令行切碎，
 *      node 报语法错 → 整个调用失败 → 版本号没升，而循环只看到 `ok === false`，
 *      于是照常打印「升级成立」——**没有任何迹象表明版本没升**。
 *   2. 脚本里的路径是相对 cwd 的仓库根（`client/package.json`、`server/package.json`），
 *      而循环的 cwd 是 `server/`，于是它改的是 `server/server/package.json`——
 *      一个不存在的路径。
 *
 * 现在直接用 fs 改 JSON：没有 shell、没有内联脚本、没有路径假设。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 仓库根（同时含 server/ 与 client/ 的那一层）。
 *
 * 只找「含 package.json」是不够的：server/ 自己也有一份 package.json，
 * 于是从 server/ 出发会把它当成根，只升 server 一个包——四个包版本从此不一致，
 * 而安装与构建读的是不同的那份。
 */
function findRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    if (
      existsSync(path.join(dir, 'package.json')) &&
      existsSync(path.join(dir, 'server', 'package.json')) &&
      existsSync(path.join(dir, 'client', 'package.json'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}

function nextVersion(v: string): string {
  const [a = 0, b = 0] = v.split('.').map((n) => Number(n) || 0);
  return `${a}.${b + 1}.0`;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown): void {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * 升版本：四个 package.json + 三个 lock 文件的根版本字段。
 * 返回新版本号；失败返回 null（**调用方必须把它显式打出来**，别让它无声无息）。
 */
export function bumpVersion(from: string = process.cwd()): string | null {
  const root = findRoot(from);
  const manifests = ['package.json', 'client/package.json', 'server/package.json', 'desktop/package.json'];
  const locks = ['package.json', 'client/package-lock.json', 'server/package-lock.json'];

  let current: string | null = null;
  for (const rel of manifests) {
    const j = readJson(path.join(root, rel));
    if (j && typeof j.version === 'string') {
      current = j.version;
      break;
    }
  }
  if (!current) return null;
  const target = nextVersion(current);

  for (const rel of manifests) {
    const abs = path.join(root, rel);
    const j = readJson(abs);
    if (!j) continue;
    j.version = target;
    writeJson(abs, j);
  }
  for (const rel of locks) {
    const abs = path.join(root, rel);
    const j = readJson(abs);
    if (!j) continue;
    if (typeof j.version === 'string') j.version = target;
    const pkg = j.packages as Record<string, { version?: string }> | undefined;
    if (pkg && pkg[''] && typeof pkg[''].version === 'string') pkg[''].version = target;
    writeJson(abs, j);
  }
  return target;
}
