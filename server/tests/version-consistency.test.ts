/**
 * 版本号一致性。
 *
 * 背景：这个仓库曾经同时存在三个版本号 —— 根/server/client 的 package.json 是
 * `1.0.0`、desktop 是 `2.0.0`、health 端点把 `'2.0.0'` 写死在代码里。
 * 结果「仓库里写的」「装出来的安装包」「健康检查自报的」三件事互相对不上，
 * 而且改版本还得改代码。
 *
 * 现在版本只在 package.json 里定义，代码读它。这套用例守的就是「别再漂回去」：
 *  - 四个包必须同版本（安装包名取自 desktop，其余跟着它走）；
 *  - 代码里的 APP_VERSION 必须等于 server 包的版本，不能是第二个真相源；
 *  - 线上 /health 返回的必须就是 APP_VERSION；
 *  - 源码里不许再出现写死的版本字面量（这条会随改回来而立刻变红）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { APP_VERSION, resolveVersion } from '../src/config/version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(here, '..');
const REPO_DIR = path.resolve(SERVER_DIR, '..');

function readVersion(relFromRepo: string): string {
  const manifest = JSON.parse(readFileSync(path.join(REPO_DIR, relFromRepo), 'utf8')) as { version?: string };
  return manifest.version ?? '(missing)';
}

const MANIFESTS = [
  'package.json',
  'server/package.json',
  'client/package.json',
  'desktop/package.json',
];

describe('版本号一致性', () => {
  it('四个 package.json 必须同版本（安装包名取自 desktop，其余跟着它走）', () => {
    const versions = MANIFESTS.map((rel) => [rel, readVersion(rel)] as const);
    const distinct = [...new Set(versions.map(([, v]) => v))];
    // 用自定义错误而不是 toHaveLength(1)：后者只会说「expected 3 to be 1」，
    // 看不出到底是哪个文件没跟上——那正是这条用例要回答的问题。
    if (distinct.length !== 1) {
      throw new Error(`版本号不一致：${versions.map(([f, v]) => `${f}=${v}`).join('，')}`);
    }
    expect(distinct).toEqual([readVersion('desktop/package.json')]);
  });

  it('代码里的 APP_VERSION 等于 server 包版本（不能有第二个真相源）', () => {
    expect(APP_VERSION).toBe(readVersion('server/package.json'));
    // 兜底：读不到 package.json 时会退化成 0.0.0，这必须被发现而不是静默上线。
    expect(APP_VERSION).not.toBe('0.0.0');
  });

  it('安装包名跟随版本，不写死文件名', () => {
    const yml = readFileSync(path.join(REPO_DIR, 'desktop', 'electron-builder.yml'), 'utf8');
    expect(yml).toContain('artifactName: CodeLens-Setup-${version}.${ext}');
  });

  it('package-lock.json 的版本与 manifest 一致（否则 npm ci 会认为两者不符）', () => {
    const pairs: Array<[string, string]> = [
      ['server/package.json', 'server/package-lock.json'],
      ['client/package.json', 'client/package-lock.json'],
    ];
    for (const [manifestRel, lockRel] of pairs) {
      const manifest = JSON.parse(readFileSync(path.join(REPO_DIR, manifestRel), 'utf8')) as { version?: string };
      const lock = JSON.parse(readFileSync(path.join(REPO_DIR, lockRel), 'utf8')) as {
        version?: string;
        packages?: Record<string, { version?: string }>;
      };
      // 两处都要对：lock 顶层的 version，以及 packages[""] 里那份（npm 7+ 两处都写）。
      expect(lock.version, `${lockRel} 顶层 version`).toBe(manifest.version);
      expect(lock.packages?.['']?.version, `${lockRel} packages[""] 的 version`).toBe(manifest.version);
    }
  });

  it('health 控制器不再写死版本字面量', () => {
    const source = readFileSync(path.join(SERVER_DIR, 'src', 'controllers', 'health.controller.ts'), 'utf8');
    // 匹配 `version: '<数字>'` 形式的字面量；改用 APP_VERSION 后这里应当没有任何命中。
    expect(source).not.toMatch(/version:\s*'\d+\.\d+\.\d+'/);
    expect(source).toContain('APP_VERSION');
  });
});

describe('/health 自报版本', () => {
  let runtime: Runtime;
  let server: http.Server;
  let base: string;
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'codelens-version-'));
    runtime = createRuntime({ dbPath: path.join(tmpRoot, 'version.db') });
    const app = createApp({ runtime, autoStartModelSync: false });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await runtime.close();
    const dir = tmpRoot;
    setImmediate(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
      }
    });
  });

  it('线上返回的版本就是 APP_VERSION（与安装包一致）', async () => {
    // health 挂在 /api/health（不带 v1），见 routes/index.ts:39。
    // 请求 /health 会命中静态托管的 SPA fallback，返回 HTML 而不是 JSON。
    const res = await fetch(`${base}/api/health`);
    const body = await res.json();
    expect(body.version).toBe(APP_VERSION);
    expect(body.version).toBe(readVersion('desktop/package.json'));
  });
});

describe('CJS 单文件形态（桌面端 esbuild bundle）', () => {
  it('import.meta.url 为空时仍能读到版本，不再抛 ERR_INVALID_ARG_VALUE', () => {
    // 模拟 app.asar 根：electron-builder 的 files 含 package.json，
    // server-bundle.cjs 与它同目录。moduleUrl=undefined 就是 CJS 产物里
    // import.meta.url 的实际值。
    const tmp = mkdtempSync(path.join(tmpdir(), 'codelens-version-cjs-'));
    try {
      writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version: '9.9.9' }));
      expect(resolveVersion(undefined, path.join(tmp, 'server-bundle.cjs'))).toBe('9.9.9');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('锚点指向不存在的 bundle 时退化成 0.0.0，绝不阻断启动', () => {
    const missing = path.join(tmpdir(), 'codelens-no-such-asar', 'server-bundle.cjs');
    expect(resolveVersion(undefined, missing)).toBe('0.0.0');
  });

  it('源码里不再出现裸的 createRequire(import.meta.url)', () => {
    const source = readFileSync(path.join(SERVER_DIR, 'src', 'config', 'version.ts'), 'utf8');
    expect(source).not.toMatch(/createRequire\(\s*import\.meta\.url\s*\)/);
  });
});
