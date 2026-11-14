#!/usr/bin/env node
/**
 * 单文件行数棘轮闸：存量按现状封顶只许缩，增量一律 ≤300 行。
 *
 * 用法：
 *   node scripts/check-file-size.mjs              # 扫 server/src + client/src 并判定
 *   node scripts/check-file-size.mjs --self-test  # 用受跟踪夹具自证（不扫盘）
 *   node scripts/check-file-size.mjs --tighten    # 把清单上限下调到实测值（人工改尺子）
 * 退出码：0 达标 / 1 有文件越线或清单有孤儿 / 2 扫描为空、清单不可得或自证失败（UNEXEC）
 *
 * 行数口径：物理行（按 \n 切分，含空行与注释）。不算「有效代码行」——那需要语言解析，
 * 而把注释和空行排除掉会让「删注释压行数」变成合规手段，正好绕过这道闸想防的事。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIMIT, evaluate, tighten } from './lib/file-size-ratchet.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'scripts', 'file-size-baseline.json');
const FIXTURE = join(ROOT, 'scripts', 'fixtures', 'file-size-ratchet', 'cases.json');
const SCAN_ROOTS = ['server/src', 'client/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 扫盘：只数 .ts/.tsx，排除 .d.ts（声明文件不是实现，行数无意义）。 */
function scan() {
  const out = [];
  const walk = (dir, rel) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs, r);
      } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
        out.push({ file: r, lines: readFileSync(abs, 'utf8').split('\n').length });
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(join(ROOT, root), root);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** 自证：用受跟踪夹具证明这道闸能红、能绿、空扫描记 UNEXEC、孤儿判红、上限只降不升。 */
function selfTest() {
  const fx = readJson(FIXTURE);
  if (!fx || !fx.cases || !fx.tighten) {
    console.error(`[ERR] 自证夹具不可得：${FIXTURE}`);
    process.exit(2);
  }
  const problems = [];
  const paths = (arr) => arr.map((x) => x.file).sort();

  for (const [name, c] of Object.entries(fx.cases)) {
    const r = evaluate(c.files, fx.entries, fx.limit ?? DEFAULT_LIMIT);
    const e = c.expect;
    if (r.unexec !== e.unexec) problems.push(`${name}: unexec=${r.unexec}，期望 ${e.unexec}`);
    if (r.passed !== e.passed) problems.push(`${name}: passed=${r.passed}，期望 ${e.passed}`);
    const got = paths(r.failures);
    const want = [...e.failures].sort();
    if (got.join('|') !== want.join('|')) problems.push(`${name}: 判红清单 [${got}]，期望 [${want}]`);
    if (e.stale && paths(r.stale).join('|') !== [...e.stale].sort().join('|')) {
      problems.push(`${name}: 孤儿清单不对`);
    }
    if (e.graduated && paths(r.graduated).join('|') !== [...e.graduated].sort().join('|')) {
      problems.push(`${name}: 可出清单不对`);
    }
  }

  const t = tighten(fx.entries, fx.tighten.files);
  for (const [file, ceiling] of Object.entries(fx.tighten.expectCeilings)) {
    const got = t.find((x) => x.file === file)?.ceiling;
    if (got !== ceiling) problems.push(`tighten: ${file} 上限=${got}，期望 ${ceiling}（只许下调）`);
  }

  if (problems.length > 0) {
    console.error('[FAIL] 行数棘轮闸自证未通过：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
  }
  console.log('[PASS] 行数棘轮闸自证：能红、能绿、空扫描记 UNEXEC、孤儿判红、上限只降不升');
  process.exit(0);
}

if (process.argv.includes('--self-test')) selfTest();

const baseline = readJson(BASELINE);
if (!baseline || !Array.isArray(baseline.entries)) {
  console.error(`[UNEXEC] 棘轮清单不可得：${BASELINE}`);
  process.exit(2);
}
const limit = baseline.limit ?? DEFAULT_LIMIT;
const files = scan();
if (files.length === 0) {
  console.error(`[UNEXEC] 扫描到 0 个文件（根：${SCAN_ROOTS.join(', ')}）—— 什么都没量到，不算通过`);
  process.exit(2);
}

if (process.argv.includes('--tighten')) {
  const next = tighten(baseline.entries, files);
  const lowered = next.filter((e, i) => e.ceiling !== baseline.entries[i].ceiling);
  if (lowered.length === 0) {
    console.log('[PASS] 棘轮清单无需下调（所有存量都未低于自己的上限）');
    process.exit(0);
  }
  for (const e of lowered) {
    const old = baseline.entries.find((x) => x.file === e.file).ceiling;
    console.log(`  下调 ${e.file}: ${old} → ${e.ceiling}`);
  }
  baseline.entries = next;
  baseline._tightenedAt = new Date().toISOString();
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  console.log(`[PASS] 已下调 ${lowered.length} 条上限（人工改尺子，attribution=human，需重锚基线）`);
  process.exit(0);
}

const { results, failures, stale, graduated, passed, scanned } = evaluate(files, baseline.entries, limit);
console.log(`行数棘轮：扫到 ${scanned} 个文件 / ${passed} 达标 / ${failures.length} 越线（上限 ${limit} 行，存量豁免 ${baseline.entries.length} 件）`);
for (const f of failures) console.log(`  FAIL  ${f.file} ${f.lines ?? '(不存在)'} 行 —— ${f.reason}`);
if (stale.length > 0) console.log(`  其中清单孤儿 ${stale.length} 件：删除/重命名后必须同步清单`);
for (const g of graduated) console.log(`  可出清单  ${g.file} 已缩到 ${g.lines} 行（≤${limit}），可从豁免里移除`);

if (failures.length > 0) {
  console.error(`[FAIL] ${failures.length} 处越线`);
  process.exit(1);
}
console.log('[PASS] 行数棘轮全部达标');
process.exit(0);