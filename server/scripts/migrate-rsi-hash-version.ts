/**
 * 迁移历史锚链的版本标记：
 *   npm run rsi:migrate-hash -- <sessionId> [--dir data/rsi] [--apply]
 *
 * 默认 dry-run，只报告会补多少行；必须显式 `--apply` 才会落盘。
 * 迁移只给缺 `hash_version` 的历史 anchor 行补 `hash_version: 1`，
 * 不重算 anchor_hash、不动 v2 行、不动 krsi 的 metric 行；重复执行是幂等的。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampMissingHashVersion } from '../src/services/rsi/ledger-migrate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sessionId = process.argv[2];
const apply = process.argv.includes('--apply');

if (!sessionId || sessionId.startsWith('--')) {
  console.error('用法：npm run rsi:migrate-hash -- <sessionId> [--dir data/rsi] [--apply]');
  process.exitCode = 2;
} else {
  main(sessionId);
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
}

function main(session: string): void {
  const rsiDir = path.resolve(arg('--dir') ?? path.join(ROOT, 'data', 'rsi'));
  const ledgerPath = path.join(rsiDir, `${safe(session)}-anchors.jsonl`);
  if (!existsSync(ledgerPath)) {
    console.error(`找不到账本：${ledgerPath}`);
    process.exitCode = 2;
    return;
  }

  const before = readFileSync(ledgerPath, 'utf-8');
  const report = stampMissingHashVersion(before);

  console.log(`账本：${ledgerPath}`);
  console.log(
    `anchor=${report.anchors}，缺 hash_version=${report.stamped}，已标注=${report.alreadyVersioned}，` +
      `非 anchor=${report.nonAnchor}，无法解析=${report.invalid}`,
  );

  if (report.stamped === 0) {
    console.log('无需迁移（幂等：没有缺少 hash_version 的行）');
    return;
  }

  if (!apply) {
    console.log('dry-run：未写入。确认后加 --apply 才会补写 hash_version: 1（不改 anchor_hash）。');
    return;
  }

  // 原子替换：先写临时文件再 rename，避免中途失败留下半截账本
  const tmp = `${ledgerPath}.migrating`;
  writeFileSync(tmp, report.content, 'utf-8');
  renameSync(tmp, ledgerPath);
  console.log(`已补写 ${report.stamped} 行 hash_version: 1。建议接着跑 npm run rsi:verify -- ${session}`);
}
