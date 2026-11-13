#!/usr/bin/env node
/**
 * rsi-tick — 任务开始前的只读体检（D0）。
 *
 * 它不写任何文件，也不触发采纳：只回答四个问题——
 *   1. 题集现在什么状态（done/pending、四维归属分布）；
 *   2. 账本覆盖了多少题、最后一条是什么时候；
 *   3. exemplars 是否存在（没有就没有正例回灌）；
 *   4. 是否存在待采纳候选。
 *
 * 用法：node scripts/rsi-tick.mjs [--json]
 * 退出码：0 = 读数成功（不代表健康）；2 = 关键文件缺失/不可读。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = join(ROOT, 'server', 'self-upgrade', 'tasks.json');
const LEDGER = join(ROOT, '.self-upgrade', 'ledger.jsonl');
const EXEMPLARS = join(ROOT, '.self-upgrade', 'exemplars.jsonl');
const CANDIDATES = join(ROOT, 'server', 'candidates');

if (!existsSync(TASKS)) {
  console.error(`[ERR] 找不到 ${TASKS}`);
  process.exit(2);
}

const doc = JSON.parse(readFileSync(TASKS, 'utf8'));
const tasks = Array.isArray(doc.tasks) ? doc.tasks : [];

const byStrengthen = {};
for (const t of tasks) {
  const k = typeof t.strengthens === 'string' ? t.strengthens : '(missing)';
  byStrengthen[k] = (byStrengthen[k] ?? 0) + 1;
}

let ledgerLines = 0;
let ledgerTasks = new Set();
let lastLedgerAt = null;
if (existsSync(LEDGER)) {
  for (const line of readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    ledgerLines += 1;
    try {
      const row = JSON.parse(line);
      if (typeof row.task === 'string') ledgerTasks.add(row.task);
      if (typeof row.at === 'string' && (!lastLedgerAt || row.at > lastLedgerAt)) lastLedgerAt = row.at;
    } catch {
      /* 坏行计入行数，但不参与覆盖统计 */
    }
  }
}

const candidateCount = existsSync(CANDIDATES)
  ? readdirSync(CANDIDATES).filter((f) => f.endsWith('.spec.json')).length
  : 0;

const report = {
  tasks: {
    total: tasks.length,
    done: tasks.filter((t) => t.status === 'done').length,
    pending: tasks.filter((t) => t.status !== 'done').length,
    byStrengthen,
  },
  ledger: {
    lines: ledgerLines,
    coveredTasks: ledgerTasks.size,
    coverage: tasks.length ? Number((ledgerTasks.size / tasks.length).toFixed(3)) : 0,
    lastAt: lastLedgerAt,
  },
  exemplars: existsSync(EXEMPLARS) ? 'present' : 'missing',
  candidates: candidateCount,
  note: 'read-only; no adoption, no writes',
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`题集：${report.tasks.total}（done ${report.tasks.done} / pending ${report.tasks.pending}）`);
  console.log(`归属：${Object.entries(byStrengthen).map(([k, v]) => `${k}=${v}`).join(' / ')}`);
  console.log(`账本：${ledgerLines} 行，覆盖 ${ledgerTasks.size}/${tasks.length}，最后一条 ${lastLedgerAt ?? '(无)'}`);
  console.log(`正例库：${report.exemplars}；待采纳候选：${candidateCount}`);
  console.log('（只读体检：不采纳、不写盘）');
}
