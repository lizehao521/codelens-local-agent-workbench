/**
 * failure-stats.mjs — 从账本里把「学习信号」捞出来。
 *
 * 账本记的是明细（每次失败的层、原因码、责任人），这个脚本回答的是聚合问题：
 *   · 哪一层在系统性失败？（同一层连续出现 = 结构性问题，不是偶发）
 *   · 哪些题从来没进过 implementation 层？（说明卡在了题/环境/模型，不该记成 Agent 差）
 *   · 哪些原因码反复出现？（那是可以直接写进任务书模板的经验）
 *
 * 用法：node scripts/failure-stats.mjs [--json]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bucketFailures, verdictsLine } from './lib/failure-buckets.mjs';

const SERVER = fileURLToPath(new URL('..', import.meta.url));
const LEDGER = join(SERVER, '..', '.self-upgrade', 'ledger.jsonl');

const LAYERS = {
  infra: { label: '环境', owner: 'scheduler' },
  budget: { label: '资源', owner: 'author' },
  behavior: { label: '行为', owner: 'model' },
  spec: { label: '规格', owner: 'author' },
  integration: { label: '集成', owner: 'agent' },
  implementation: { label: '实现', owner: 'agent' },
  judge: { label: '判据', owner: 'author' },
};

if (!existsSync(LEDGER)) {
  console.log(`没有账本：${LEDGER}`);
  process.exit(0);
}

const rows = readFileSync(LEDGER, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const failures = rows.filter((r) => r.verdict === 'failed' && typeof r.layer === 'string');
const upgraded = rows.filter((r) => r.verdict === 'upgraded');
const { unexec: rulerNotReached, ranFailed } = bucketFailures(failures);
const gaps = [...new Set(rulerNotReached.map((f) => f.task ?? '(unknown)'))];
const summaryLine = verdictsLine({
  unexec: rulerNotReached.length,
  fail: ranFailed.length,
  pass: upgraded.length,
  gaps,
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ failures, upgraded, buckets: { unexec: rulerNotReached, ranFailed }, verdicts: summaryLine }, null, 2));
  process.exit(0);
}

const count = (arr, key) =>
  arr.reduce((acc, r) => {
    const k = r[key] ?? '(none)';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

console.log(`\n账本：${rows.length} 行（升级 ${upgraded.length} 次，带归因的失败 ${failures.length} 次）`);
console.log(`尺子没跑（unexec，不计入能力账）：${rulerNotReached.length} 次｜跑了没过：${ranFailed.length} 次`);
console.log(summaryLine);
console.log(`无归因的旧失败记录：${rows.filter((r) => r.verdict === 'failed' && !r.layer).length} 条（分层机制上线前的老账）`);

if (failures.length === 0) {
  console.log('\n还没有带归因的失败记录。跑一轮循环后再看。');
  process.exit(0);
}

console.log('\n── 按层分布 ─────────────────────────────');
const byLayer = count(failures, 'layer');
for (const [layer, n] of Object.entries(byLayer).sort((a, b) => b[1] - a[1])) {
  const meta = LAYERS[layer] ?? { label: layer, owner: '?' };
  const agentShare = failures.filter((f) => f.layer === layer && f.attribution?.countsAgainstAgent).length;
  console.log(
    `  ${String(n).padStart(2)} 次  ${meta.label.padEnd(4, '　')}  (${layer})  责任=${meta.owner.padEnd(9)}` +
      `  计入Agent ${agentShare}/${n}`,
  );
}

console.log('\n── 按原因码分布 ─────────────────────────');
for (const [code, n] of Object.entries(count(failures, 'code')).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(2)} 次  ${code}`);
}

console.log('\n── 按题 ─────────────────────────────────');
const byTask = {};
for (const f of failures) {
  const t = f.task ?? '(unknown)';
  byTask[t] = byTask[t] ?? { layers: {}, total: 0, agent: 0 };
  byTask[t].total += 1;
  byTask[t].layers[f.layer] = (byTask[t].layers[f.layer] ?? 0) + 1;
  if (f.attribution?.countsAgainstAgent) byTask[t].agent += 1;
}
for (const [task, info] of Object.entries(byTask)) {
  const shape = Object.entries(info.layers)
    .map(([l, n]) => `${LAYERS[l]?.label ?? l}×${n}`)
    .join(' ');
  const verdict = info.agent === 0 ? '  ← 从未进过实现层：问题不在 Agent' : '';
  console.log(`  ${task}: ${info.total} 次失败（计入 Agent ${info.agent}）｜${shape}${verdict}`);
}

// ── 可复用信号：同层同码出现 ≥2 次，说明它不是偶发，而是可以写进模板的经验 ──
const signals = [];
for (const [code, n] of Object.entries(count(failures, 'code'))) {
  if (n < 2) continue;
  const sample = failures.find((f) => f.code === code);
  const layer = sample?.layer ?? '?';
  signals.push({ code, n, layer, owner: LAYERS[layer]?.owner ?? '?' });
}
if (signals.length > 0) {
  console.log('\n── 可复用信号（重复出现 = 系统性问题）────');
  for (const s of signals.sort((a, b) => b.n - a.n)) {
    console.log(`  ${s.code} ×${s.n}（${LAYERS[s.layer]?.label ?? s.layer}层，责任 ${s.owner}）`);
    if (s.code === 'NO_TOOL_CALL') {
      console.log('    → 该换模型或压缩任务书；任务书长度与空转强相关。');
    } else if (s.code === 'EXPLORATION_ONLY') {
      console.log('    → 检查任务书是否自相矛盾/缺信息；它在研究一份写错了的题。');
    } else if (s.code === 'BUDGET_EXHAUSTED' || s.code === 'MAX_ITERATIONS') {
      console.log('    → 拆题；一次派单的验证面越大，越容易在探索阶段被掐断。');
    } else if (s.code === 'BEHAVIOR_WRONG') {
      console.log('    → 这是真缺陷，诊断里的断言差异可以直接进下一轮反馈。');
    } else if (s.code === 'FULL_SUITE_RED' || s.code === 'TYPECHECK_RED') {
      console.log('    → 判据覆盖不到「接进产品」，考虑在判据里加一条注册/回归断言。');
    } else if (s.code.startsWith('INFRA_')) {
      console.log('    → 循环自身的缺陷，先修调度器再谈 Agent 能力。');
    }
  }
}

console.log('');
