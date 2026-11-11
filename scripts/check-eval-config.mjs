/**
 * 评测 / 上游配置一致性自检（只读，不修改任何文件）。
 *
 * 背景：2026-11-10 上游换址时，旧地址散落在 8 个文件里，人工逐个替换极易漏项。
 * 依据：Anthropic《Demystifying evals for AI agents》(2026-01-09) —— 评估 harness
 * 必须标准化，同一模型换 scaffold 可差 10–20 分；Terminal-Bench 4.0 亦把资源
 * 规则变更列为「破坏性变更」。因此把「测量环境是否一致」变成机器可判的门禁。
 *
 * 检查项：
 *  1) 所有源码/配置里出现的远程上游地址必须唯一；
 *  2) 若 server/.env 存在，其 TRIAL_BASE_URL / DEEP_ASSESSOR_BASE_URL 必须与该地址一致；
 *  3) 127.0.0.1 的本地示例地址单独分组，不参与一致性判定。
 *
 * 用法：npm run check:config（发现漂移 exit 1）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONFIG_FILES = [
  'server/start.sh',
  'server/scripts/seed-agent-run.ts',
  'client/vite.config.ts',
  'client/.env.example',
  'client/src/lib/storage.ts',
  'client/src/components/settings/ProviderZone.tsx',
  'config/modelsync.json',
];

const URL_RE = /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\/v1\b/g;
const isLocal = (url) => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url);

/** @type {Map<string, string[]>} */
const occurrences = new Map();
for (const rel of CONFIG_FILES) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) continue;
  const urls = [...new Set(readFileSync(abs, 'utf8').match(URL_RE) ?? [])];
  for (const url of urls) {
    if (!occurrences.has(url)) occurrences.set(url, []);
    occurrences.get(url).push(rel);
  }
}

const remote = [...occurrences.entries()].filter(([url]) => !isLocal(url));
const problems = [];

if (remote.length === 0) {
  problems.push('源码/配置中没有发现任何远程上游地址，无法判断是否一致');
} else if (remote.length > 1) {
  problems.push(
    `发现 ${remote.length} 个不同的远程上游地址：\n` +
      remote.map(([url, files]) => `    ${url}\n      <- ${files.join(', ')}`).join('\n'),
  );
}

const envPath = path.join(ROOT, 'server', '.env');
let canonical = remote.length === 1 ? remote[0][0] : null;
if (existsSync(envPath)) {
  const text = readFileSync(envPath, 'utf8');
  for (const key of ['TRIAL_BASE_URL', 'DEEP_ASSESSOR_BASE_URL']) {
    const match = text.match(new RegExp(`^${key}=(\\S+)`, 'm'));
    if (!match) continue;
    const value = match[1].replace(/\/+$/, '');
    if (canonical && value !== canonical) {
      problems.push(`server/.env 的 ${key}=${value} 与源码中的 ${canonical} 不一致`);
    }
  }
}

if (problems.length > 0) {
  console.error('[check:config] 配置不一致：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log('[check:config] 上游配置一致');
if (canonical) {
  console.log(`  地址：${canonical}`);
  console.log(`  覆盖：${remote[0][1].length} 个源码/配置文件` + (existsSync(envPath) ? ' + server/.env' : ''));
}
const local = [...occurrences.keys()].filter(isLocal);
if (local.length > 0) console.log(`  本地示例（不参与判定）：${local.join(', ')}`);
