/** test.run — 跑单个测试文件，返回通过/失败详情。 */

import { existsSync } from 'node:fs';
import { readFile, unlink, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { resolveInSandboxAsync, resolveProjectRoot } from './path-jail.js';
import { buildCleanEnv } from './spawn-env.js';
import { killProcessTree } from './process-tree.js';
import type { ToolDefinition, ToolOutcome } from '../../types/tool.js';

function extractAssertionMessage(failureMessages: string[]): string {
  for (const msg of failureMessages) {
    const lines = msg.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed.includes('AssertionError') ||
        trimmed.startsWith('Error:') ||
        trimmed.startsWith('expect(') ||
        trimmed.includes('Expected:') ||
        trimmed.includes('Received:')
      ) {
        const cleaned = trimmed.replace(/\\s+/g, ' ').slice(0, 400);
        if (!cleaned.includes('node_modules') && !/^[\\s]*[~^]/.test(cleaned)) {
          return cleaned;
        }
      }
    }
  }
  // fallback: first non-empty line without node_modules/stack arrows
  for (const msg of failureMessages) {
    const firstLine = msg.split('\n')[0]?.trim() ?? '';
    if (firstLine && !firstLine.includes('node_modules') && !/^[~^]/.test(firstLine)) {
      return firstLine.slice(0, 400);
    }
  }
  return 'Test failed';
}



export const testRunTool: ToolDefinition = {
  name: 'test.run',
  wireName: 'test_run',
  displayName: '跑测试',
  category: 'compute',
  description: '跑指定的单个测试文件，返回通过/失败详情。可用 root 指定项目根（仓库不在沙箱内时必须传）。',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '相对项目根的测试路径，tests/ 下且 .test.ts 结尾', maxLength: 512 },
      root: {
        type: 'string',
        description: '项目根（含 node_modules 与 vitest 配置的目录）。默认沙箱根；仓库不在沙箱内时必须传，且须是某个授权目录或它的上级。',
        maxLength: 512,
      },
      timeoutMs: { type: 'number', description: '超时毫秒，默认 60000，范围 1000..120000' },
    },
    required: ['file'],
    additionalProperties: false,
  },
  timeoutMs: 120000,
  risk: 'medium',
  approvalMode: 'none',
  source: 'builtin',
  idempotent: false,
  maxResultChars: 4000,
  enabled: () => true,
  handler: async (args, ctx): Promise<ToolOutcome> => {
    const file = String(args.file ?? '');
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 60000), 1000), 120000);

    // ⓪ 项目根：默认沙箱根；传了就必须是沙箱/授权目录/授权目录的上级。
    //
    // 这一条原来不存在，代价是：仓库在沙箱外时，vitest 只能从沙箱的
    // node_modules 起、cwd 也是沙箱，于是「跑测试」永远在一个空项目里跑，
    // 读不到报告就报 REPORT_READ_FAILED —— 被测对象从头到尾是错的。
    let projectRoot = ctx.sandboxRoot;
    const rootArg = String(args.root ?? '').trim();
    if (rootArg) {
      const rootJail = await resolveProjectRoot(ctx.sandboxRoot, rootArg, ctx.allowedDirs);
      if (!rootJail.ok) {
        return {
          ok: false,
          summary: rootJail.message,
          error: { code: 'TOOL_SECURITY_DENIED', kind: 'security', message: rootJail.message, retryable: false },
        };
      }
      projectRoot = rootJail.absolutePath;
    }

    // ① path-jail（相对项目根解析：传了 root 就以 root 为基准）
    const jail = await resolveInSandboxAsync(projectRoot, file, false, undefined, undefined);
    if (!jail.ok) {
      return {
        ok: false,
        summary: jail.message,
        error: { code: 'TOOL_SECURITY_DENIED', kind: 'security', message: jail.message, retryable: false },
      };
    }

    // ② format check
    if (!/^tests\//.test(file) || !file.endsWith('.test.ts')) {
      return {
        ok: false,
        summary: '只接受 tests/ 下的 .test.ts',
        error: { code: 'UNSUPPORTED_TARGET', kind: 'invalid_args', message: '只接受 tests/ 下的 .test.ts' },
      };
    }

    // ③ exists
    if (!existsSync(jail.absolutePath)) {
      return {
        ok: false,
        summary: '测试文件不存在',
        error: { code: 'NOT_FOUND', kind: 'not_found', message: '测试文件不存在' },
      };
    }

    // ④ vitest 必须来自**项目根**的依赖树。缺失时说清是「根传错了」而不是「报告读不到」。
    const vitestEntry = join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs');
    if (!existsSync(vitestEntry)) {
      const msg = `项目根下没有 vitest：${vitestEntry}（若仓库不在沙箱内，请用 root 指定项目根，例如含 package.json 与 node_modules 的 server 目录）`;
      return {
        ok: false,
        summary: '项目根缺少 vitest 依赖',
        error: { code: 'VITEST_MISSING', kind: 'invalid_args', message: msg },
      };
    }

    // Prepare temp output file
    const tmpDir = await mkdtemp(join(tmpdir(), 'vitest-'));
    const outputFile = join(tmpDir, 'results.json');

    const child = spawn(process.execPath, [
      vitestEntry,
      'run',
      file,
      '--reporter=json',
      `--outputFile=${outputFile}`,
    ], {
      cwd: projectRoot,
      env: buildCleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid!);
    }, timeoutMs);

    try {
      await new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (_code, signal) => {
          clearTimeout(timeoutHandle);
          if (timedOut) {
            return reject(new Error('TEST_TIMEOUT'));
          }
          if (signal === 'SIGKILL' || signal === 'SIGTERM') {
            return reject(new Error('TEST_TIMEOUT'));
          }
          resolve();
        });
      });
    } catch (err) {
      if (timedOut || (err instanceof Error && err.message === 'TEST_TIMEOUT')) {
        return {
          ok: false,
          summary: '测试超时',
          error: { code: 'TEST_TIMEOUT', kind: 'timeout', message: '测试超时' },
        };
      }
      throw err;
    }

    // Read results
    let report: any;
    try {
      const content = await readFile(outputFile, 'utf8');
      report = JSON.parse(content);
    } catch {
      return {
        ok: false,
        summary: '无法读取测试报告',
        error: { code: 'REPORT_READ_FAILED', kind: 'internal', message: '无法读取测试报告' },
      };
    } finally {
      try { await unlink(outputFile); } catch {}
      try { await unlink(tmpDir); } catch {}
    }

    const testResults = report?.testResults ?? [];
    let total = 0, passed = 0, failed = 0;
    const failures: Array<{ name: string; message: string }> = [];

    for (const suite of testResults) {
      for (const assertion of suite.assertionResults ?? []) {
        total++;
        if (assertion.status === 'passed') {
          passed++;
        } else if (assertion.status === 'failed') {
          failed++;
          failures.push({
            name: assertion.fullName ?? assertion.title ?? 'unknown',
            message: extractAssertionMessage(assertion.failureMessages ?? []),
          });
        }
      }
    }

    if (failed === 0) {
      return {
        ok: true,
        summary: `全部通过：${passed}/${total}`,
        data: { total, passed, failed, failures: [] },
      };
    }

    return {
      ok: false,
      summary: `失败 ${failed}/${total}`,
      error: { code: 'TEST_FAILED', kind: 'invalid_args', message: `失败 ${failed}/${total}` },
      data: { total, passed, failed, failures },
    };
  },
};