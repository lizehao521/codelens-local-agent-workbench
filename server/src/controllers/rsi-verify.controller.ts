/**
 * RSI Verify Controller — 运行验收测试并回传结果给 Minis。
 *
 * 流程：
 *   1. Zod 校验入参（proposalId, suite）
 *   2. 启动对应测试套件：
 *      - acceptance: npm run test:acceptance (含 typecheck / vitest / krsi / 套件地板 / C1 / 工具契约)
 *      - unit: npm run test:unit
 *      - e2e: playwright (bash scripts/e2e.sh)
 *   3. 捕获结果：{passed, total, score, regression: boolean, logs[]}
 *   4. POST 回 Minis：POST http://<minis-host>/rsi/verification
 *   5. 返回验收结果给前端
 *
 * 环境变量：
 *   MINIS_HOST - Minis 服务地址（默认 http://localhost:3001）
 *   MINIS_VERIFY_TOKEN - 回传认证 token（可选）
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Db } from '../repositories/db.js';
import { AppError, ErrorCode } from '../utils/errors.js';

const SERVER = fileURLToPath(new URL('../..', import.meta.url));
const WORK = path.resolve(SERVER, '..', '.self-upgrade');
const LEDGER = path.join(WORK, 'ledger.jsonl');

const VerifySchema = z.object({
  proposalId: z.string().min(1).max(128),
  suite: z.enum(['acceptance', 'unit', 'e2e']),
});

type VerifyInput = z.infer<typeof VerifySchema>;

interface SuiteResult {
  passed: number;
  total: number;
  score: number; // 0-100
  regression: boolean;
  logs: string[];
  durationMs: number;
}

function appendLedger(entry: Record<string, unknown>): void {
  mkdirSync(WORK, { recursive: true });
  writeFileSync(LEDGER, `${JSON.stringify(entry)}\n`, { flag: 'a', encoding: 'utf8' });
}

function runCommand(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ stdout, stderr: stderr + '\n[TIMEOUT]', exitCode: -1 });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + '\n' + e.message, exitCode: -1 });
    });
  });
}

async function runAcceptance(): Promise<SuiteResult> {
  const start = Date.now();
  const { stdout, stderr, exitCode } = await runCommand('npm', ['run', 'test:acceptance'], SERVER, 300_000);
  const durationMs = Date.now() - start;

  // 解析 vitest 输出获取 passed/total
  let passed = 0;
  let total = 0;
  const passMatch = stdout.match(/(\d+)\s+passed/);
  const failMatch = stdout.match(/(\d+)\s+failed/);
  const skipMatch = stdout.match(/(\d+)\s+skipped/);
  if (passMatch && passMatch[1]) passed = parseInt(passMatch[1], 10);
  if (failMatch && failMatch[1]) total += parseInt(failMatch[1], 10);
  if (skipMatch && skipMatch[1]) total += parseInt(skipMatch[1], 10);
  total += passed;

  const score = total > 0 ? Math.round((passed / total) * 100) : 0;
  const regression = exitCode !== 0;

  return {
    passed,
    total,
    score,
    regression,
    logs: [stdout, stderr].filter(Boolean),
    durationMs,
  };
}

async function runUnit(): Promise<SuiteResult> {
  const start = Date.now();
  // 使用 vitest run 代替 test:unit（该脚本不存在）
  const { stdout, stderr, exitCode } = await runCommand('npx', ['vitest', 'run'], SERVER, 180_000);
  const durationMs = Date.now() - start;

  let passed = 0;
  let total = 0;
  const passMatch = stdout.match(/(\d+)\s+passed/);
  const failMatch = stdout.match(/(\d+)\s+failed/);
  if (passMatch && passMatch[1]) passed = parseInt(passMatch[1], 10);
  if (failMatch && failMatch[1]) total += parseInt(failMatch[1], 10);
  total += passed;

  const score = total > 0 ? Math.round((passed / total) * 100) : 0;
  const regression = exitCode !== 0;

  return {
    passed,
    total,
    score,
    regression,
    logs: [stdout, stderr].filter(Boolean),
    durationMs,
  };
}

async function runE2E(): Promise<SuiteResult> {
  const start = Date.now();
  const { stdout, stderr, exitCode } = await runCommand('bash', ['scripts/e2e.sh'], SERVER, 300_000);
  const durationMs = Date.now() - start;

  // e2e 通常只有通过/失败
  const passed = exitCode === 0 ? 1 : 0;
  const total = 1;
  const score = passed * 100;
  const regression = exitCode !== 0;

  return {
    passed,
    total,
    score,
    regression,
    logs: [stdout, stderr].filter(Boolean),
    durationMs,
  };
}

async function postToMinis(proposalId: string, suite: string, result: SuiteResult): Promise<void> {
  const minisHost = process.env.MINIS_HOST ?? 'http://localhost:3001';
  const token = process.env.MINIS_VERIFY_TOKEN ?? '';

  const body = JSON.stringify({
    proposalId,
    suite,
    suiteResults: result,
    regression: result.regression,
    logs: result.logs,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // 使用 fetch (Node 18+)
  try {
    await fetch(`${minisHost}/rsi/verification`, {
      method: 'POST',
      headers,
      body,
    });
  } catch (e) {
    // 回传失败不阻断主流程，只记录日志
    console.warn('[rsi-verify] 回传 Minis 失败:', e instanceof Error ? e.message : String(e));
  }
}

export class RsiVerifyController {
  constructor(private readonly db: Db) {}

  async verify(req: Request, res: Response): Promise<void> {
    const parse = VerifySchema.safeParse(req.body);
    if (!parse.success) {
      const messages = parse.error.issues.map((e: { message: string }) => e.message).join('; ');
      res.status(400).json({ error: { code: ErrorCode.VALIDATION_ERROR, message: messages } });
      return;
    }
    const { proposalId, suite } = parse.data;

    let result: SuiteResult;
    try {
      switch (suite) {
        case 'acceptance':
          result = await runAcceptance();
          break;
        case 'unit':
          result = await runUnit();
          break;
        case 'e2e':
          result = await runE2E();
          break;
        default:
          res.status(400).json({ error: { code: ErrorCode.VALIDATION_ERROR, message: `未知 suite: ${suite}` } });
          return;
      }
    } catch (e) {
      res.status(500).json({ error: { code: ErrorCode.INTERNAL_ERROR, message: e instanceof Error ? e.message : '验收运行失败' } });
      return;
    }

    // 追加 ledger
    appendLedger({
      type: 'verify',
      at: new Date().toISOString(),
      proposalId,
      suite,
      passed: result.passed,
      total: result.total,
      score: result.score,
      regression: result.regression,
      durationMs: result.durationMs,
      ok: !result.regression,
    });

    // 异步回传 Minis（不阻塞响应）
    postToMinis(proposalId, suite, result).catch(() => {});

    res.json({
      proposalId,
      suite,
      passed: result.passed,
      total: result.total,
      score: result.score,
      regression: result.regression,
      durationMs: result.durationMs,
      logs: result.logs.slice(0, 50), // 限制返回日志量
    });
  }
}