/**
 * RSI 账本离线校验：`npm run rsi:verify -- <sessionId> [--dir data/rsi] [--db data/codelens.db]`
 *
 * 解决 `rsi-loop.md` §5/§6 记的「还没有独立的离线校验 CLI」：
 * 不启动 server、不调 krsi，直接拿磁盘上的锚链 + 库里的 manifest 原文 + 证据文件，
 * 把 evidence → manifest → anchor → 链 四层全部复算一遍。
 *
 * 退出码：0 = 全链通过；1 = 发现问题（逐条打印 code 与代数）；2 = 参数/文件缺失。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../src/repositories/db.js';
import { verifyLedger, type AnchorLine } from '../src/services/rsi/ledger-verify.js';

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
  const bad = new Map<number | null, string[]>();
  for (const p of report.problems) {
    const key = p.generation;
    if (!bad.has(key)) bad.set(key, []);
    bad.get(key)!.push(`${p.code}: ${p.detail}`);
  }
  for (const a of anchors) {
    const issues = bad.get(a.generation);
    const mark = issues ? '✗' : '✓';
    console.log(
      `${mark} g${a.generation}  verdict=${a.verdict}  exit=${a.exit_code ?? 'null'}  ` +
        `anchor=${String(a.anchor_hash).slice(0, 12)}…  manifest=${String(a.manifest_hash).slice(0, 12)}…`,
    );
    for (const issue of issues ?? []) console.log(`    ${issue}`);
  }
  for (const issue of bad.get(null) ?? []) console.log(`  ${issue}`);

  console.log(report.ok ? '\n结论：全链通过（evidence → manifest → anchor → 链 均一致）' : '\n结论：发现不一致，见上');
  process.exitCode = report.ok ? 0 : 1;
}
