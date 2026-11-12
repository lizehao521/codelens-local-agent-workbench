#!/usr/bin/env node
/**
 * judge-audit.mjs — 判据自证体检。
 *
 * ── 它对应哪条铁律 ────────────────────────────────────────
 * 「C3 · 自证：判据本身会骗人。所以每一条判据都要有正常例、金丝雀、破坏夹具、判别力自证。」
 * 「强化 ≠ 忙碌：一次跑绿，但破坏夹具打不红 ⇒ 不是强化。」
 *
 * 全自动的破坏夹具（变异测试）成本高且对每类靶子都不一样，但这个体检能机械地抓住
 * 最常见的那种橡皮图章：**判据里全是正向断言**。
 *
 *   · 一条只有 `expect(o.ok).toBe(true)` 的判据，在实现「一律返回 ok」时也会绿；
 *   · 它抓不住的问题是「改坏了还是绿」，而这恰恰是判据失职最典型的样子。
 *
 * 所以规则是：每个判据文件至少要有 **1 条反向断言**（期望失败/期望被拒），
 * 且反向断言占比不低于 20%。低于这个线，它更像一份「功能说明书」而不是判据。
 *
 * 用法：node scripts/judge-audit.mjs [--strict]
 *   --strict：把不达标当失败退出（围栏用）
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(SERVER, 'tests', 'self-upgrade');
const STRICT = process.argv.includes('--strict');

/** 反向断言：期望失败、期望抛错、期望被拒绝。 */
const NEGATIVE = [
  /\.toBe\(\s*false\s*\)/g,
  /\.toBeFalsy\(\)/g,
  /\.rejects\b/g,
  /\.toThrow\b/g,
  /\.not\.toBe\(\s*true\s*\)/g,
];
/** 正向断言：期望成功。 */
const POSITIVE = [/\.toBe\(\s*true\s*\)/g, /\.toBeTruthy\(\)/g, /\.resolves\b/g, /\.toEqual\(/g, /\.toMatchObject\(/g];

const count = (src, list) => list.reduce((n, re) => n + (src.match(re)?.length ?? 0), 0);

const rows = [];
for (const name of readdirSync(DIR).filter((f) => f.endsWith('.test.ts'))) {
  const src = readFileSync(join(DIR, name), 'utf8');
  const its = src.match(/\bit\(/g)?.length ?? 0;
  const neg = count(src, NEGATIVE);
  const pos = count(src, POSITIVE);
  const total = neg + pos;
  const ratio = total === 0 ? 0 : neg / total;
  const skipped = /skipIf|\.skip\(/.test(src);
  // 判据里出现 skip 就是「可能永远不跑」，必须单独标出来 —— 我们被假绿坑过一次。
  const verdict = total === 0 ? 'NO-ASSERT' : neg === 0 ? 'NO-NEGATIVE' : ratio < 0.2 ? 'WEAK' : 'OK';
  rows.push({ name, its, neg, pos, ratio, skipped, verdict });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n判据自证体检：${rows.length} 个文件\n`);
console.log(`${pad('判据文件', 40)} ${pad('用例', 5)} ${pad('正向', 5)} ${pad('反向', 5)} ${pad('反向占比', 9)} ${pad('skip', 5)} 结论`);
console.log('-'.repeat(96));
for (const r of rows) {
  console.log(
    `${pad(r.name, 40)} ${pad(r.its, 5)} ${pad(r.pos, 5)} ${pad(r.neg, 5)} ` +
      `${pad(`${(r.ratio * 100).toFixed(0)}%`, 9)} ${pad(r.skipped ? 'YES' : '-', 5)} ` +
      `${r.verdict === 'OK' ? 'OK' : `${r.verdict}  ← ${r.verdict === 'NO-NEGATIVE' ? '只有正向断言，改坏了也会绿' : r.verdict === 'NO-ASSERT' ? '没有任何断言' : '反向断言偏少'}`}`,
  );
}

const bad = rows.filter((r) => r.verdict !== 'OK');
console.log(`\n结论：${rows.length - bad.length}/${rows.length} 通过自证体检`);
if (bad.length > 0) {
  console.log('不达标：' + bad.map((r) => r.name).join('、'));
  if (STRICT) {
    console.log('\n--strict：判据自证不达标，视为不构成一次升级。');
    process.exit(1);
  }
}
console.log('');
