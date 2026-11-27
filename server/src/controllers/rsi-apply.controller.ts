/**
 * RSI Apply Patch Controller — 接收 Minis 推送的 Patch 并应用到代码库。
 *
 * 流程：
 *   1. Zod 校验入参（proposalId, patch, targetPath, kind）
 *   2. 静态扫描：AST 白名单（仅允许 src/tools/ src/utils/ client/src/components/），
 *      禁止 eval/Function/dynamic import/require 等动态代码执行模式
 *   3. git apply --check 干跑
 *   4. 创建回滚点（createRollbackPoint）
 *   5. git apply 正式应用
 *   6. 记录 append-only ledger
 *   7. 返回 {applied: true, filesChanged: string[]}
 *
 * 幂等性：同一 proposalId 重复调用返回 409（已处理）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Db } from '../repositories/db.js';
import { checkDomain, createRollbackPoint, rollbackTo, type ChangeDomainId } from '../services/rsi/change-domain.js';
import { AppError, ErrorCode } from '../utils/errors.js';

const SERVER = fileURLToPath(new URL('../..', import.meta.url));
const WORK = path.resolve(SERVER, '..', '.self-upgrade');
const LEDGER = path.join(WORK, 'ledger.jsonl');
const PROCESSED = path.join(WORK, 'processed-proposals.json');

const ApplyPatchSchema = z.object({
  proposalId: z.string().min(1).max(128),
  patch: z.string().min(1),
  targetPath: z.string().min(1).max(512),
  kind: z.enum(['patch', 'skill', 'eval']),
});

type ApplyPatchInput = z.infer<typeof ApplyPatchSchema>;

const ALLOWED_PREFIXES = [
  'src/tools/',
  'src/utils/',
  'client/src/components/',
];

const FORBIDDEN_PATTERNS = [
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\brequire\s*\(\s*['"`][^'"`]*['"`]\s*\)/,
  /\bimport\s*\(\s*['"`][^'"`]*['"`]\s*\)/,
  /\bglobalThis\b/,
  /\bprocess\.(env|exit|kill)/,
  /\bchild_process\b/,
  /\bfs\.(write|read|unlink|rm|mkdir)/,
  /\bnet\./,
  /\bhttp\./,
  /\bhttps\./,
];

function staticScan(patch: string, targetPath: string): { ok: boolean; reason?: string } {
  // 1. 目标路径白名单
  const allowed = ALLOWED_PREFIXES.some((p) => targetPath.startsWith(p));
  if (!allowed) {
    return { ok: false, reason: `targetPath 不在允许目录内：${targetPath}（允许：${ALLOWED_PREFIXES.join(', ')}）` };
  }

  // 2. 扫描补丁中新增行（以 + 开头，非 +++ 文件头）中的禁止模式
  const addedLines = patch.split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(addedLines)) {
      return { ok: false, reason: `新增行包含禁止模式：${re.source}` };
    }
  }

  // 3. 补丁必须是 unified diff 格式（以 ---/+++ 开头）
  if (!/^--- /m.test(patch) || !/^\+\+\+ /m.test(patch)) {
    return { ok: false, reason: '补丁格式不合法：非 unified diff' };
  }

  return { ok: true };
}

function readProcessed(): Set<string> {
  if (!existsSync(PROCESSED)) return new Set();
  try {
    const data = readFileSync(PROCESSED, 'utf8');
    return new Set(JSON.parse(data) as string[]);
  } catch {
    return new Set();
  }
}

function writeProcessed(set: Set<string>): void {
  mkdirSync(WORK, { recursive: true });
  writeFileSync(PROCESSED, JSON.stringify([...set].slice(-1000)), 'utf8');
}

function appendLedger(entry: Record<string, unknown>): void {
  mkdirSync(WORK, { recursive: true });
  appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`, 'utf8');
}

function extractFilesFromPatch(patch: string): string[] {
  const files: string[] = [];
  const lines = patch.split('\n');
  for (const line of lines) {
    const m = line.match(/^\+\+\+\s+(.+)$/);
    if (m && m[1]) {
      let f = m[1].trim();
      if (f.startsWith('b/')) f = f.slice(2);
      if (f !== '/dev/null') files.push(f);
    }
  }
  return [...new Set(files)];
}

export class RsiApplyController {
  constructor(private readonly db: Db) {}

  applyPatch(req: Request, res: Response): void {
    const parse = ApplyPatchSchema.safeParse(req.body);
    if (!parse.success) {
      const messages = parse.error.issues.map((e: { message: string }) => e.message).join('; ');
      res.status(400).json({ error: { code: ErrorCode.VALIDATION_ERROR, message: messages } });
      return;
    }
    const { proposalId, patch, targetPath, kind } = parse.data;

    // 幂等性检查
    const processed = readProcessed();
    if (processed.has(proposalId)) {
      res.status(409).json({ error: { code: 'ALREADY_PROCESSED', message: `proposal ${proposalId} 已处理` } });
      return;
    }

    // 静态扫描
    const scan = staticScan(patch, targetPath);
    if (!scan.ok) {
      res.status(400).json({ error: { code: 'STATIC_SCAN_FAILED', message: scan.reason } });
      return;
    }

    // 解析补丁涉及的文件
    const files = extractFilesFromPatch(patch);
    if (files.length === 0) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '补丁未包含任何文件变更' } });
      return;
    }

    // 变更域判定：优先使用 targetPath（完整路径），忽略补丁中提取的相对路径
    const domainFiles = targetPath ? [targetPath] : files;
    const domainCheck = checkDomain({ files: domainFiles, trigger: 'manual', humanApproved: true });
    if (!domainCheck.ok) {
      res.status(403).json({ error: { code: 'DOMAIN_REJECTED', message: domainCheck.reasons.join('; ') } });
      return;
    }

    // git apply --check 干跑
    let dryRunOk = false;
    try {
      execFileSync('git', ['apply', '--check', '-'], { input: patch, encoding: 'utf8', cwd: SERVER, timeout: 10_000 });
      dryRunOk = true;
    } catch (e) {
      res.status(400).json({ error: { code: 'GIT_APPLY_CHECK_FAILED', message: e instanceof Error ? e.message : 'git apply --check 失败' } });
      return;
    }

    // 创建回滚点
    const rollbackPoint = createRollbackPoint({ id: proposalId, root: SERVER, files, git: true });

    // 正式应用
    let applied = false;
    let filesChanged: string[] = [];
    try {
      execFileSync('git', ['apply', '-'], { input: patch, encoding: 'utf8', cwd: SERVER, timeout: 30_000 });
      applied = true;
      filesChanged = files;
    } catch (e) {
      // 应用失败，尝试回滚
      rollbackTo(rollbackPoint, SERVER);
      res.status(500).json({ error: { code: 'GIT_APPLY_FAILED', message: e instanceof Error ? e.message : 'git apply 失败，已回滚' } });
      return;
    }

    // 记录处理过的 proposalId
    processed.add(proposalId);
    writeProcessed(processed);

    // 追加 ledger
    appendLedger({
      type: 'apply-patch',
      at: new Date().toISOString(),
      proposalId,
      kind,
      targetPath,
      filesChanged,
      domain: domainCheck.domain,
      rollbackPointId: rollbackPoint.id,
      ok: true,
    });

    res.json({ applied: true, filesChanged });
  }
}