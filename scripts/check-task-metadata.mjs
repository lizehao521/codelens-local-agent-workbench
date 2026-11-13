#!/usr/bin/env node
/**
 * C1 元数据闸：每道自我升级题必须回答「它强化了 Act / Judge / Update / Memory 哪一维」。
 *
 * 为什么放在仓库根 scripts/ 而不是 server/scripts/：
 * server/scripts/ 是围栏的受保护路径（改它=改尺子），而这道闸本身要能随 C1 演进；
 * 它只读 tasks.json 与外部账本，不参与判据计算，放在根目录不会削弱围栏。
 *
 * 判据分层（C4）：
 *   - 硬失败：字段缺失 / 取值非法 / id 重复 / done 却无 releasedIn / 非 done 却有 releasedIn
 *   - 账本核对：done 题是否在 .self-upgrade/ledger.jsonl 里有 verified 记录
 *     账本曾从 57 条缩到 7 条（真实数据丢失），所以覆盖率**只报不判**，
 *     缺账本时退出码 3（UNEXEC），绝不当成通过。
 *
 * 退出码：0 通过 / 1 元数据违规 / 2 tasks.json 不可读 / 3 账本不可得（UNEXEC）
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = join(ROOT, 'server', 'self-upgrade', 'tasks.json');
const LEDGER = join(ROOT, '.self-upgrade', 'ledger.jsonl');
const DIMENSIONS = new Set(['Act', 'Judge', 'Update', 'Memory']);
const QUIET = process.argv.includes('--quiet');

const failures = [];
const notes = [];

if (!existsSync(TASKS)) {
  console.error(`[ERR] 找不到 ${TASKS}`);
  process.exit(2);
}

let doc;
try {
  doc = JSON.parse(readFileSync(TASKS, 'utf8'));
} catch (err) {
  console.error(`[ERR] tasks.json 解析失败：${err.message}`);
  process.exit(2);
}

const tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
const ids = new Set();

for (const t of tasks) {
  const id = String(t.id ?? '');
  if (!id) failures.push('存在没有 id 的题');
  if (ids.has(id)) failures.push(`id 重复：${id}`);
  ids.add(id);

  if (typeof t.title !== 'string' || !t.title.trim()) failures.push(`${id}: title 为空`);
  if (!DIMENSIONS.has(t.strengthens)) {
    failures.push(`${id}: strengthens=${JSON.stringify(t.strengthens)} 不在 Act/Judge/Update/Memory 内`);
  }
  if (t.status === 'done' && !t.releasedIn) failures.push(`${id}: status=done 但缺 releasedIn`);
  if (t.status !== 'done' && t.releasedIn) failures.push(`${id}: 非 done 却写了 releasedIn=${t.releasedIn}`);
}

let coverage = null;
if (existsSync(LEDGER)) {
  const verified = new Set();
  for (const line of readFileSync(LEDGER, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.task && e.verdict === 'verified') verified.add(e.task);
    } catch {
      notes.push('账本存在无法解析的行（已跳过）');
    }
  }
  const done = tasks.filter((t) => t.status === 'done').map((t) => t.id);
  const covered = done.filter((id) => verified.has(id));
  coverage = { done: done.length, covered: covered.length, missing: done.filter((id) => !verified.has(id)) };
}

const byDim = {};
for (const t of tasks) byDim[t.strengthens] = (byDim[t.strengthens] ?? 0) + 1;

if (!QUIET) {
  console.log(`题数 ${tasks.length}：` + Object.entries(byDim).map(([k, v]) => `${k}=${v}`).join(' ') || '无');
  if (coverage) {
    console.log(`账本覆盖（只报不判）：${coverage.covered}/${coverage.done}`);
    if (coverage.missing.length) {
      console.log(`  未覆盖：${coverage.missing.join(', ')}`);
    }
  } else {
    console.log('账本覆盖：UNEXEC（账本不存在，不判通过）');
  }
}

for (const n of notes) console.error(`[WARN] ${n}`);

if (failures.length) {
  console.error(`[FAIL] C1 元数据闸：${failures.length} 项违规`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

if (!QUIET) console.log('[PASS] C1 元数据闸：字段与状态一致');
if (!coverage) {
  if (!QUIET) console.log('[UNEXEC] 账本不可得：覆盖率未判，按 C4 不算通过');
  process.exit(3);
}
process.exit(0);
