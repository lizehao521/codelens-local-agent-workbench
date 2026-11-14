#!/usr/bin/env node
/**
 * 覆盖率地板闸：低于地板就红，报告不可得就 UNEXEC（绝不当成通过）。
 *
 * 为什么是「局部」地板而不是全仓库一个数：src/ 里有大量尚未被测的模块，
 * 全仓库行覆盖此刻很低，把地板定在那个数上等于永远红、于是被人关掉；
 * 定在 0 上等于没有闸。所以地板按范围给：判据密集的工具层要求高，
 * 其余范围先只要求「可测量、不退步」。
 *
 * 用法：
 *   node scripts/check-coverage-floor.mjs --package=server
 *   node scripts/check-coverage-floor.mjs --self-test
 * 退出码：0 全部达标 / 1 有范围低于地板 / 2 报告不可得或自证失败（UNEXEC）
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from './lib/coverage-floor.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FLOORS = join(ROOT, 'scripts', 'coverage-floors.json');
const FIXTURE = join(ROOT, 'scripts', 'fixtures', 'coverage-floor', 'summary.json');
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? '').slice(`--${k}=`.length) || undefined;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 自证：用受跟踪夹具证明这道闸能红、且缺报告时不会假绿。 */
function selfTest() {
  const fixture = readJson(FIXTURE);
  if (!fixture) {
    console.error(`[ERR] 自证夹具不可得：${FIXTURE}`);
    process.exit(2);
  }
  const rules = fixture.rules;
  const problems = [];

  const low = evaluate(fixture.belowFloor, rules);
  if (low.failures.length === 0) problems.push('低于地板的夹具没有判红 —— 这道闸是装饰');

  // 只断言「有失败」抓不到平均口径：把百分比求平均时 src/mixed 会读成 50%（假绿），
  // 而 src/tools 仍然红，failures.length 照样 > 0。所以必须点名这条陷阱规则的真实读数。
  const mixed = low.results.find((r) => r.prefix === 'src/mixed');
  if (!mixed || mixed.status !== 'fail' || mixed.pct === null || mixed.pct > 5) {
    problems.push(
      `10 行全覆盖 + 990 行零覆盖被聚合成 ${mixed?.pct ?? '不可判'}% —— 用了平均百分比而不是累加 covered/total`,
    );
  }

  const missing = evaluate(null, rules);
  if (missing.passed !== 0 || missing.unexec !== rules.length) {
    problems.push('报告不可得时没有全记 UNEXEC —— 违反 C4');
  }

  const zero = evaluate(fixture.zeroDenominator, rules);
  if (zero.passed !== 0) problems.push('分母为 0 的范围被算成达标 —— 凭空发明覆盖率');

  const good = evaluate(fixture.aboveFloor, rules);
  if (good.failures.length !== 0 || good.unexec !== 0) {
    problems.push('高于地板的夹具没有判绿 —— 闸只会红不会绿，同样是坏的');
  }

  if (problems.length > 0) {
    console.error('[FAIL] 覆盖率地板闸自证未通过：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
  }
  console.log('[PASS] 覆盖率地板闸自证：能红、能绿、缺报告记 UNEXEC、零分母不判满分');
  process.exit(0);
}

if (process.argv.includes('--self-test')) selfTest();

const pkg = arg('package');
if (pkg !== 'server' && pkg !== 'client') {
  console.error('[ERR] 必须指定 --package=server|client');
  process.exit(2);
}

const floors = readJson(FLOORS);
if (!floors || !Array.isArray(floors.rules)) {
  console.error(`[ERR] 地板定义不可得：${FLOORS}`);
  process.exit(2);
}
const rules = floors.rules.filter((r) => r.package === pkg);
if (rules.length === 0) {
  console.error(`[ERR] ${pkg} 没有任何地板规则 —— 无闸可判，按 UNEXEC 处理`);
  process.exit(2);
}

const reportFile = join(ROOT, pkg, 'coverage', 'coverage-summary.json');
if (!existsSync(reportFile)) {
  console.error(`[UNEXEC] 覆盖率报告不存在：${reportFile}`);
  console.error(`        先跑 cd ${pkg} && npm run test:coverage`);
  process.exit(2);
}
const summary = readJson(reportFile);
if (!summary) {
  console.error(`[UNEXEC] 覆盖率报告不可解析：${reportFile}`);
  process.exit(2);
}

const { results, failures, unexec, passed } = evaluate(summary, rules);
console.log(`覆盖率地板（${pkg}）：${passed} 达标 / ${failures.length} 低于地板 / ${unexec} 不可判`);
for (const r of results) {
  const scope = r.prefix || '(total)';
  const pct = r.pct === null ? 'UNEXEC' : `${r.pct}%`;
  const mark = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'UNEXEC';
  console.log(`  ${mark}  ${scope} ${r.metric} ${pct} ≥ ${r.min}%${r.reason ? ` —— ${r.reason}` : ''}`);
}

if (unexec > 0) {
  console.error('[UNEXEC] 有范围不可判：按 C4 不算通过');
  process.exit(2);
}
if (failures.length > 0) {
  console.error(`[FAIL] ${failures.length} 个范围低于地板`);
  process.exit(1);
}
console.log('[PASS] 覆盖率地板全部达标');
process.exit(0);