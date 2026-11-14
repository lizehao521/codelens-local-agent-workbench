/**
 * agent.verify — 跑「这个包自己声明的验证命令」，返回结构化读数。
 *
 * 为什么是工具而不是提示词：
 *   「改完必须验」写在提示词里，模型可以读完代码就说「已通过」——没有任何读数能反驳它。
 *   做成工具后，通过/失败来自真实进程的退出码，判据和人都能复核。
 *
 * 安全边界：
 *   · 只接受 package = server | client | root，不接受任意 cwd；
 *   · 只跑 package.json 里 `verify` 数组声明、且 `scripts` 里真实存在的脚本名；
 *   · 参数里没有命令字符串，命令只能来自仓库内的声明文件。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildCleanEnv } from './spawn-env.js';
import { killProcessTree } from './process-tree.js';
import type { ToolDefinition, ToolOutcome } from '../../types/tool.js';

export type VerifyPackage = 'server' | 'client' | 'root';

export interface VerifyEntry {
  name: string;
  script: string;
}

export interface VerifyCheckResult {
  name: string;
  script: string;
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  durationMs: number;
  tail: string;
}

const SCRIPT_NAME = /^[a-zA-Z][a-zA-Z0-9:_-]{0,40}$/;

/**
 * 解析某个 package.json 的 `verify` 声明。
 *
 * 只认「脚本名数组」这一种形状：命令本身仍然来自 package.json 的 scripts，
 * 工具不拼接、不解释、不执行声明之外的任何东西。
 */
export function parseVerifyPlan(pkg: unknown): { entries: VerifyEntry[]; error?: string } {
  const obj = (pkg ?? {}) as { verify?: unknown; scripts?: unknown };
  const scripts = (obj.scripts ?? {}) as Record<string, unknown>;
  if (!Array.isArray(obj.verify)) {
    return { entries: [], error: 'package.json 没有声明 verify（应为脚本名数组，例如 ["typecheck","test"]）' };
  }
  if (obj.verify.length === 0) return { entries: [], error: 'verify 声明为空' };
  const entries: VerifyEntry[] = [];
  const seen = new Set<string>();
  for (const raw of obj.verify) {
    const name = String(raw);
    if (!SCRIPT_NAME.test(name)) return { entries: [], error: `verify 含非法脚本名：${name}` };
    if (seen.has(name)) return { entries: [], error: `verify 重复声明：${name}` };
    const script = scripts[name];
    if (typeof script !== 'string' || !script.trim()) {
      return { entries: [], error: `verify 声明了 ${name}，但 scripts 里没有这个脚本` };
    }
    seen.add(name);
    entries.push({ name, script });
  }
  return { entries };
}

/** 包名 → 目录。只认三个固定名字，避免把任意路径变成可执行 cwd。 */
export function resolvePackageDir(kind: VerifyPackage, sandboxRoot: string): string {
  if (kind === 'server') return sandboxRoot;
  const parent = path.resolve(sandboxRoot, '..');
  if (kind === 'client') {
    const beside = path.join(parent, 'client');
    return existsSync(path.join(beside, 'package.json')) ? beside : path.join(sandboxRoot, 'client');
  }
  return existsSync(path.join(parent, 'package.json')) ? parent : sandboxRoot;
}

function runOne(entry: VerifyEntry, cwd: string, timeoutMs: number): Promise<VerifyCheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(`npm run ${entry.name}`, {
      cwd,
      shell: true,
      env: buildCleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let buf = '';
    const append = (d: Buffer): void => {
      buf += d.toString();
      // 只留末尾：失败时真正有用的是断言与退出码，不是整屏安装日志。
      if (buf.length > 24_000) buf = buf.slice(-16_000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid!);
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        name: entry.name,
        script: entry.script,
        exitCode: null,
        passed: false,
        timedOut: false,
        durationMs: Date.now() - started,
        tail: `无法启动 npm：${err.message}`,
      });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const tail = buf.replace(/\r/g, '').trim().split('\n').slice(-20).join('\n').slice(-1200);
      resolve({
        name: entry.name,
        script: entry.script,
        exitCode: code,
        passed: !timedOut && code === 0 && signal === null,
        timedOut,
        durationMs: Date.now() - started,
        tail: timedOut ? `[超时 ${timeoutMs}ms]\n${tail}` : tail,
      });
    });
  });
}

/** 结构化汇总（纯函数，便于单测）：ok 只有当所有 check 都真的通过。 */
export function summarizeResults(results: VerifyCheckResult[]): {
  ok: boolean;
  passed: number;
  failed: number;
  total: number;
  failedChecks: string[];
} {
  const failedChecks = results.filter((r) => !r.passed).map((r) => r.name);
  return {
    ok: results.length > 0 && failedChecks.length === 0,
    passed: results.length - failedChecks.length,
    failed: failedChecks.length,
    total: results.length,
    failedChecks,
  };
}

export const agentVerifyTool: ToolDefinition = {
  name: 'agent.verify',
  wireName: 'agent_verify',
  displayName: '验证改动',
  category: 'compute',
  description:
    '按目标包 package.json 的 verify 声明跑验证脚本（默认全部），返回每个脚本的退出码、耗时与输出末尾。只接受已声明的脚本名，不接受任意命令。',
  inputSchema: {
    type: 'object',
    properties: {
      package: {
        type: 'string',
        enum: ['server', 'client', 'root'],
        description: '要验证的包，默认 server',
      },
      checks: {
        type: 'array',
        items: { type: 'string' },
        description: '只跑指定的脚本名（必须在 verify 声明里）；省略 = 全部',
      },
      timeoutMs: {
        type: 'number',
        description: '单个脚本超时毫秒，默认 300000，范围 1000..600000',
      },
    },
    additionalProperties: false,
  },
  timeoutMs: 600_000,
  risk: 'medium',
  approvalMode: 'none',
  source: 'builtin',
  idempotent: false,
  maxResultChars: 5000,
  enabled: () => true,
  handler: async (args, ctx): Promise<ToolOutcome> => {
    const pkg = String(args.package ?? 'server') as VerifyPackage;
    if (pkg !== 'server' && pkg !== 'client' && pkg !== 'root') {
      return {
        ok: false,
        summary: `未知 package：${pkg}`,
        error: { code: 'INVALID_PACKAGE', kind: 'invalid_args', message: 'package 只能是 server / client / root' },
      };
    }
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 300_000), 1000), 600_000);
    const dir = resolvePackageDir(pkg, ctx.sandboxRoot);
    const pkgFile = path.join(dir, 'package.json');
    if (!existsSync(pkgFile)) {
      return {
        ok: false,
        summary: `找不到 ${pkg} 的 package.json`,
        error: { code: 'PACKAGE_NOT_FOUND', kind: 'not_found', message: pkgFile },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(pkgFile, 'utf8'));
    } catch (err) {
      return {
        ok: false,
        summary: 'package.json 解析失败',
        error: {
          code: 'PACKAGE_JSON_INVALID',
          kind: 'invalid_args',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const plan = parseVerifyPlan(parsed);
    if (plan.error) {
      return {
        ok: false,
        summary: plan.error,
        error: {
          code: 'NO_VERIFY_PLAN',
          kind: 'invalid_args',
          message: plan.error,
          suggestion: '在 package.json 增加 "verify": ["typecheck","test"]（脚本必须真实存在于 scripts）',
        },
      };
    }

    let selected = plan.entries;
    if (Array.isArray(args.checks) && args.checks.length > 0) {
      const wanted = args.checks.map(String);
      const known = new Set(plan.entries.map((e) => e.name));
      const unknown = wanted.filter((n) => !known.has(n));
      if (unknown.length > 0) {
        return {
          ok: false,
          summary: `未声明的验证脚本：${unknown.join('、')}`,
          error: {
            code: 'CHECK_NOT_DECLARED',
            kind: 'invalid_args',
            message: `可用：${[...known].join('、')}`,
          },
        };
      }
      selected = plan.entries.filter((e) => wanted.includes(e.name));
    }

    const results: VerifyCheckResult[] = [];
    for (const entry of selected) {
      ctx.reportProgress('verify', `运行 ${entry.name}…`);
      results.push(await runOne(entry, dir, timeoutMs));
    }
    const sum = summarizeResults(results);
    const data = {
      package: pkg,
      directory: dir,
      passed: sum.passed,
      failed: sum.failed,
      total: sum.total,
      checks: results,
    };
    if (sum.ok) {
      return {
        ok: true,
        summary: `验证通过 ${sum.passed}/${sum.total}（${results.map((r) => `${r.name} ${r.durationMs}ms`).join('，')}）`,
        data,
      };
    }
    const failedNames = sum.failedChecks.join('、');
    return {
      ok: false,
      summary: `验证失败 ${sum.failed}/${sum.total}：${failedNames}`,
      error: {
        code: 'VERIFY_FAILED',
        kind: 'internal',
        message: `以下脚本未通过：${failedNames}`,
        retryable: false,
      },
      data,
    };
  },
};
