#!/usr/bin/env node
/**
 * 变异探针：把实现改坏，判据必须变红。
 *
 * 为什么需要它：`judge-audit.mjs` 只统计「反向断言占比」，证明不了判据有判别力；
 * 一条 `expect(...).toBe(true)` 配一条 `expect(...).toBe(false)` 也能刷到 50%。
 * 这里做的是最原始也最可信的检查：改坏源码 → 跑判据 → 期望非零退出。
 *
 * 约束：
 *   - 只接受「源串在文件里恰好出现 hits 次」的变异，避免误改多处；
 *   - 目标文件必须 git clean，跑完在 finally 里按字节还原并校验 sha256；
 *     `--dirty` 显式放行脏文件（人工注入器的固化），仍然先备份字节、跑完还原并核对 sha256。
 *   - 判据文件必须存在，否则「非零退出」可能只是路径写错，不是判别力；
 *   - 超时 180s；任何异常都先还原再退出，不把工作区留在改坏状态。
 *
 * 用法：
 *   node scripts/mutation-probe.mjs            # 全跑
 *   node scripts/mutation-probe.mjs --dry      # 只校验源串/脏净/判据存在，不改盘
 *   node scripts/mutation-probe.mjs --only=id  # 只跑一个变异体
 *   node scripts/mutation-probe.mjs --dirty    # 允许脏文件：按字节备份 + 注入 + finally 还原 + sha256 对账
 * 退出码：0 全部被杀 / 1 有存活变异体 / 2 环境或还原失败
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTATIONS } from './lib/mutations.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? '').slice(`--${k}=`.length) || undefined;
const DRY = process.argv.includes('--dry');
/** 允许脏文件：只在显式 --dirty 时生效，仍然字节备份 + finally 还原 + sha256 对账。 */
const DIRTY = process.argv.includes('--dirty');
const ONLY = arg('only');

/** 三个根：靶子可以在 server/、client/，也可以在仓库根（尺子侧脚本）。 */
const baseOf = (name) => (name === 'repo' ? ROOT : join(ROOT, name));
/** git 的路径一律相对仓库根，否则脏净检查永远查的是不存在的路径。 */
const repoRelOf = (fileRoot, file) => (fileRoot === 'repo' ? file : `${fileRoot}/${file}`);

function gitClean(repoRel) {
  const r = spawnSync('git', ['status', '--porcelain', '--', repoRel], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
  });
  return r.status === 0 && r.stdout.trim() === '';
}

const selected = ONLY ? MUTATIONS.filter((m) => m.id === ONLY) : MUTATIONS;
if (ONLY && selected.length === 0) {
  console.error(`[ERR] --only=${ONLY} 没有匹配的变异体`);
  process.exit(2);
}

let failed = 0;
let envError = false;
let ran = 0;
const coveredTasks = new Set();

for (const m of selected) {
  const pkg = m.pkg ?? 'server';
  const fileRoot = m.fileRoot ?? pkg;
  const abs = join(baseOf(fileRoot), m.file);
  const repoRel = repoRelOf(fileRoot, m.file);
  const judgeAbs = join(baseOf(pkg), m.test);
  const tag = `${m.id}${pkg === 'server' ? '' : ` [${pkg}]`}`;

  if (!existsSync(abs)) {
    console.error(`[ERR] ${tag}: 靶子不存在 ${repoRel}`);
    envError = true;
    continue;
  }
  if (!existsSync(judgeAbs)) {
    console.error(`[ERR] ${tag}: 判据不存在 ${pkg}/${m.test} —— 非零退出会被误读成「变异体被杀」`);
    envError = true;
    continue;
  }
  if (!gitClean(repoRel)) {
    if (!DIRTY) {
      console.error(`[SKIP] ${tag}: 目标文件有未提交改动，拒绝在脏文件上做变异（确需人工注入时加 --dirty）`);
      envError = true;
      continue;
    }
    console.warn(`[DIRTY] ${tag}: 目标文件有未提交改动，按 --dirty 继续（字节备份 + 还原 + sha256 对账）`);
  }

  const original = readFileSync(abs);
  const before = sha(original);
  const text = original.toString('utf8');
  const hits = text.split(m.from).length - 1;
  const expectedHits = m.hits ?? 1;
  if (hits !== expectedHits) {
    console.error(`[ERR] ${tag}: 源串出现 ${hits} 次（要求恰好 ${expectedHits} 次），拒绝执行`);
    envError = true;
    continue;
  }

  if (DRY) {
    console.log(`[OK] ${tag} → ${repoRel}（源串唯一，判据在位，工作区干净）`);
    coveredTasks.add(m.task);
    continue;
  }

  const mutated = text.split(m.from).join(m.to);
  let result;
  let restoreOk = true;
  try {
    writeFileSync(abs, mutated, 'utf8');
    result = spawnSync(`npx vitest run ${m.test} --reporter=dot`, {
      cwd: baseOf(pkg),
      encoding: 'utf8',
      timeout: 180_000,
      shell: true,
    });
  } finally {
    writeFileSync(abs, original);
    if (sha(readFileSync(abs)) !== before) {
      console.error(`[ERR] ${tag}: 还原校验失败（sha256 不一致），请立即 git checkout -- ${repoRel}`);
      envError = true;
      restoreOk = false;
    }
  }
  if (!restoreOk) continue;

  ran += 1;
  coveredTasks.add(m.task);
  const timedOut = result.error?.code === 'ETIMEDOUT';
  if (timedOut) {
    // 超时不是「被杀」：判据可能根本没跑完，把它算成判别力就是自欺。
    console.error(`[ERR] ${tag}: 判据超时，结果不可信`);
    envError = true;
    continue;
  }
  if (result.status !== 0) {
    console.log(`[KILLED] ${tag} — ${m.why}`);
  } else {
    console.error(`[SURVIVED] ${tag} — 判据仍绿：${pkg}/${m.test}（${m.why}）`);
    failed += 1;
  }
}

// 覆盖率按「题」去重，不按变异体个数：同一道题挂两个变异体不等于覆盖了两道题。
let taskTotal = null;
try {
  const doc = JSON.parse(readFileSync(join(ROOT, 'server', 'self-upgrade', 'tasks.json'), 'utf8'));
  taskTotal = Array.isArray(doc.tasks) ? doc.tasks.length : null;
} catch {
  console.error('[WARN] 读不到 tasks.json，覆盖率分母 UNEXEC');
}
const realTasks = [...coveredTasks].filter((t) => t !== '_infra');
if (taskTotal !== null) {
  console.log(`逐题变异覆盖：${realTasks.length}/${taskTotal} 题（另有基础设施变异 ${coveredTasks.has('_infra') ? 2 : 0} 个）`);
}

if (envError) process.exit(2);
if (DRY) {
  console.log(`变异探针 --dry：${selected.length} 个变异体前置全部就绪（未改盘）`);
  process.exit(0);
}
if (failed > 0) {
  console.error(`变异探针：${failed}/${ran} 个变异体存活`);
  process.exit(1);
}
console.log(`变异探针：${ran}/${ran} 个变异体全部被杀死`);