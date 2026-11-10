/**
 * RSI 账本离线校验：`npm run rsi:verify -- <sessionId> [--dir data/rsi] [--db data/codelens.db]`
 *
 * 解决 `rsi-loop.md` §5/§6 记的「还没有独立的离线校验 CLI」：
 * 不启动 server、不调 krsi，直接拿磁盘上的锚链 + 库里的 manifest 原文 + 证据文件，
 * 把 evidence → manifest → anchor → 链 四层全部复算一遍。
 *
 * 版本口径：缺 `hash_version` 的历史行按 v1 复算；新行按 v2（canonical JSON + §6 原像）。
 * 两版本可以混排在同一条链上，逐行报告实际使用的版本。
 *
 * 退出码：
 *   0 = 全链通过；
 *   1 = 发现篡改/链断/证据不一致（真问题）；
 *   2 = 参数或账本文件缺失；
 *   3 = 只有「不认识的 hash_version」——无法判定，不等于篡改。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../src/repositories/db.js';
import { verifyLedger, hashVersionOf, type AnchorLine, type VerifyProblem } from '../src/services/rsi/ledger-verify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sessionId = process.argv[2];
if (!sessionId || sessionId.startsWith('--')) {
  console.error('用法：npm run rsi:verify -- <sessionId> [--dir data/rsi] [--db data/codelens.db]');
  process.exitCode = 2;
} else {
  main(sessionId);
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
}

function group(problems: VerifyProblem[], kinds: VerifyProblem['kind'][]): VerifyProblem[] {
  return problems.filter((p) => kinds.includes(p.kind));
}

function printGroup(title: string, problems: VerifyProblem[]): void {
  if (problems.length === 0) return;
  console.log(`\n${title}`);
  for (const p of problems) {
    const at = p.generation === null ? '' : `g${p.generation} `;
    console.log(`  ${at}${p.code}: ${p.detail}`);
  }
}

function main(session: string): void {
  const rsiDir = path.resolve(arg('--dir') ?? path.join(ROOT, 'data', 'rsi'));
  const dbPath = path.resolve(
    arg('--db') ?? process.env.AGENT_DB_PATH ?? path.join(ROOT, 'data', 'codelens.db'),
  );
  const ledgerPath = path.join(rsiDir, `${safe(session)}-anchors.jsonl`);

  if (!existsSync(ledgerPath)) {
    console.error(`找不到账本：${ledgerPath}`);
    process.exitCode = 2;
    return;
  }

  // ── 锚链：只取 type='anchor' 的行（krsi 也会往同一个账本写 metric 行） ──
  const anchors: AnchorLine[] = [];
  for (const [index, raw] of readFileSync(ledgerPath, 'utf-8').split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.error(`账本第 ${index + 1} 行不是合法 JSON，判定失败`);
      process.exitCode = 1;
      return;
    }
    if (parsed?.type === 'anchor') anchors.push(parsed as AnchorLine);
  }

  // ── 每代 manifest 原文 ──
  const db = createDb(dbPath);
  const manifests = new Map<number, string>();
  try {
    const rows = db.all<{ generation: number; next_manifest_json: string | null }>(
      `SELECT generation, next_manifest_json FROM policy_rsi_runs
        WHERE session_id = ? AND next_manifest_json IS NOT NULL`,
      [session],
    );
    for (const row of rows) manifests.set(row.generation, row.next_manifest_json as string);
  } finally {
    db.close();
  }

  // ── 证据文件：manifest 里存的是相对进程 cwd 的路径；找不到就按文件名回退到 rsiDir ──
  const report = verifyLedger({
    anchors,
    manifests,
    readEvidence: (rel) => {
      const direct = path.resolve(rel);
      if (existsSync(direct)) return readFileSync(direct);
      const fallback = path.join(rsiDir, path.basename(rel));
      return existsSync(fallback) ? readFileSync(fallback) : null;
    },
  });

  console.log(`账本：${ledgerPath}`);
  console.log(`锚点：${report.anchorCount} 行，代数 [${report.generations.join(', ')}]`);
  const counts = Object.entries(report.versionCounts)
    .map(([v, n]) => `v${v} ${n} 行`)
    .join('，');
  console.log(`版本分布：${counts}`);
  console.log(
    `复算用的哈希口径：${report.versions
      .map((v) => (v === 1 ? 'v1(legacy)' : v === 2 ? 'v2(canonical)' : `v${v}(unknown)`))
      .join(' → ')}`,
  );

  for (const a of anchors) {
    const version = hashVersionOf(a);
    const lineProblems = report.problems.filter((p) => p.generation === a.generation);
    const mark = lineProblems.length === 0 ? '✓' : lineProblems.every((p) => p.kind === 'version') ? '?' : '✗';
    console.log(
      `${mark} g${a.generation}  hv=${version}  verdict=${a.verdict}  exit=${a.exit_code ?? 'null'}  ` +
        `anchor=${String(a.anchor_hash).slice(0, 12)}…  manifest=${String(a.manifest_hash).slice(0, 12)}…`,
    );
    for (const p of lineProblems) console.log(`    [${p.kind}] ${p.code}: ${p.detail}`);
  }

  printGroup('── 篡改 / 链不一致（tamper / chain）──', group(report.problems, ['tamper', 'chain']));
  printGroup('── 版本无法识别（version，无法判定，不等于篡改）──', group(report.problems, ['version']));
  printGroup('── 环境 / 数据缺失（environment）──', group(report.problems, ['environment']));
  for (const issue of report.problems) {
    if (issue.generation !== null) continue;
    if (issue.kind === 'tamper' || issue.kind === 'chain' || issue.kind === 'version') continue;
    console.log(`  ${issue.code}: ${issue.detail}`);
  }

  if (report.ok) {
    console.log('\n结论：全链通过（evidence → manifest → anchor → 链 均一致）');
    process.exitCode = 0;
  } else if (report.undecidableByVersion) {
    console.log('\n结论：无法判定 —— 账本含不认识的 hash_version；未发现篡改证据，但也不能确认一致性');
    process.exitCode = 3;
  } else {
    console.log('\n结论：发现篡改或不一致，见上面的分组');
    process.exitCode = 1;
  }
}
