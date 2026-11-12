/**
 * type.check — 在项目根跑 `tsc --noEmit`，把类型错误变成结构化结果。
 *
 * ── 为什么 code.check 不够 ────────────────────────────────
 * `code.check` 只把单文件源码喂给 `stripTypeScriptTypes`：它验的是**语法**，
 * 不是类型。类型错了它照样报「语法正确」。
 * 于是 Agent 想自证「类型干净」只剩 `sys.exec` 一条路，而 `sys.exec` 每次都
 * 要人批（sandbox 兜底不放行）——它因此倾向绕开验证，直接宣称改完了。
 *
 * ── 三个必须说清的失败态 ──────────────────────────────────
 *   1. 根下没有 tsconfig.json  → TSCONFIG_MISSING（大概率 root 传错了）
 *   2. 根下没有 typescript     → TSC_MISSING（同上，指错地方比报错更贵）
 *   3. tsc 退出非 0 但解析不出诊断 → TSC_FAILED（配置错误等，附原文尾部）
 * 只有「解析出 TS 诊断」才算 TYPE_ERRORS。四种错误码指向四个不同的修法。
 *
 * ── 副作用 ────────────────────────────────────────────────
 * 只读：`--noEmit` 不产出 JS。不传 `--incremental`，避免往仓库写 .tsbuildinfo。
 * 与 test.run 共用 `resolveProjectRoot`：根只能是沙箱内 / 授权目录内 / 授权目录的上级。
 *
 * ── 为什么不再整块缓存 stdout（2026-11-13 修）────────────────
 * 原实现把 stdout 拼成字符串并限长 256KB，超出就静默丢弃。于是 `total` 变成
 * 「前 256KB 里的错误数」而非全项目错误数——大项目上少报，而且没有任何字段
 * 标出「我截过」。这条是 CodeLens 侧 Agent 自己提名、并给出复现路径的真缺陷。
 * 现改为**流式收集**：逐行匹配、只保留前 N 条明细，但计数器始终全量递增，
 * 内存占用与输出体积无关，也就不再存在「少报」。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveProjectRoot } from './path-jail.js';
import { buildCleanEnv } from './spawn-env.js';
import { killProcessTree } from './process-tree.js';
import type { ToolDefinition, ToolOutcome } from '../../types/tool.js';

/** `src/a.ts(12,5): error TS2322: xxx` —— Windows 盘符里的 `:` 不会被误切，因为行首按 `(` 定位。 */
const DIAG_RE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

export interface TypeDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

/**
 * 解析 tsc 输出。导出是为了让判据能直接锁解析行为，
 * 不必每次都真起一个 tsc 子进程（慢且依赖 node_modules）。
 */
/**
 * 流式诊断收集器：按行喂入，计数全量、明细限量。
 *
 * 为什么流式：tsc 在大项目上可能吐几十万行，整块缓存要么占内存、要么截断；
 * 一旦截断，`total` 就会少报（旧实现正是这个错）。这里只保留一行缓冲与最多 limit 条明细。
 */
export class DiagnosticCollector {
  private carry = '';
  private readonly errors: TypeDiagnostic[] = [];
  private total = 0;

  constructor(private readonly limit = 20) {}

  push(chunk: string): void {
    const text = this.carry + chunk;
    const lines = text.split(/\r?\n/);
    // 最后一段可能被切在行中间，留给下一块。
    this.carry = lines.pop() ?? '';
    // 防御：单个「行」异常长（无换行的大型垃圾输出）时不让 carry 无限增长。
    if (this.carry.length > 8192) this.carry = this.carry.slice(-8192);
    for (const line of lines) this.consume(line);
  }

  end(): void {
    if (this.carry.length > 0) {
      this.consume(this.carry);
      this.carry = '';
    }
  }

  private consume(rawLine: string): void {
    const m = DIAG_RE.exec(rawLine.trimEnd());
    if (!m) return;
    this.total += 1;
    if (this.errors.length >= this.limit) return;
    this.errors.push({
      file: m[1]!,
      line: parseInt(m[2]!, 10),
      column: parseInt(m[3]!, 10),
      code: m[4]!,
      message: m[5]!.slice(0, 300),
    });
  }

  result(): { errors: TypeDiagnostic[]; total: number } {
    return { errors: this.errors, total: this.total };
  }
}

/**
 * 解析完整 tsc 输出（保留给判据与离线复用）。
 * 实现委托给流式收集器，避免两套解析逻辑各自漂移。
 */
export function parseTscOutput(stdout: string, limit = 20): { errors: TypeDiagnostic[]; total: number } {
  const collector = new DiagnosticCollector(limit);
  collector.push(stdout);
  collector.end();
  return collector.result();
}

/** 退出码非 0 且无诊断时，取输出尾部给模型看（配置错误通常只有一两行）。 */
function tail(text: string, maxChars = 600): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : '…' + trimmed.slice(-maxChars);
}

export const typeCheckTool: ToolDefinition = {
  name: 'type.check',
  wireName: 'type_check',
  displayName: '检查类型',
  category: 'compute',
  description: '在项目根跑 tsc --noEmit，返回类型错误清单（文件:行:列 + TS 码）。只读，不产出 JS。必须能定位到含 tsconfig.json 与 node_modules 的项目根。',
  inputSchema: {
    type: 'object',
    properties: {
      root: {
        type: 'string',
        description: '项目根（含 tsconfig.json 与 node_modules 的目录，通常是仓库的 server 或 client 目录）。默认沙箱根；仓库不在沙箱内时必须传，且须是某个授权目录或它的上级。',
        maxLength: 512,
      },
      timeoutMs: { type: 'number', description: '超时毫秒，默认 120000，范围 5000..300000' },
      maxErrors: { type: 'number', description: '最多返回多少条诊断，默认 20，范围 1..50' },
    },
    additionalProperties: false,
  },
  timeoutMs: 300000,
  risk: 'low',
  approvalMode: 'none',
  source: 'builtin',
  idempotent: true,
  maxResultChars: 4000,
  enabled: () => true,
  handler: async (args, ctx): Promise<ToolOutcome> => {
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 120000), 5000), 300000);
    const maxErrors = Math.min(Math.max(Number(args.maxErrors ?? 20), 1), 50);

    // ① 项目根：语义与 test.run 完全一致，避免两套「根」判据漂移。
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

    // ② 根下必须有 tsconfig.json：没有就是「根错了」，不是「类型错了」。
    const tsconfig = join(projectRoot, 'tsconfig.json');
    if (!existsSync(tsconfig)) {
      const msg = `项目根下没有 tsconfig.json：${tsconfig}（若仓库不在沙箱内，请用 root 指定项目根，例如含 tsconfig.json 的 server 目录）`;
      return {
        ok: false,
        summary: '项目根缺少 tsconfig.json',
        error: { code: 'TSCONFIG_MISSING', kind: 'invalid_args', message: msg },
      };
    }

    // ③ tsc 必须来自**项目根**的依赖树 —— 否则验的是别的版本，结论不可信。
    const tscEntry = join(projectRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
    if (!existsSync(tscEntry)) {
      const msg = `项目根下没有 typescript：${tscEntry}（root 可能指错了；需要含 node_modules/typescript 的目录）`;
      return {
        ok: false,
        summary: '项目根缺少 typescript 依赖',
        error: { code: 'TSC_MISSING', kind: 'invalid_args', message: msg },
      };
    }

    const child = spawn(process.execPath, [tscEntry, '--noEmit', '--pretty', 'false'], {
      cwd: projectRoot,
      // NODE_ENV=development：与 test.run 的 'test' 区分开——type.check 检的是
      // 生产口径的类型，别让某个项目按 NODE_ENV 切换的 tsconfig 影响结论。
      env: buildCleanEnv('development'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    let timedOut = false;
    const collector = new DiagnosticCollector(maxErrors);
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid!);
    }, timeoutMs);

    // 逐块喂给收集器：不缓存全文，也就不会因截断而少报 total。
    child.stdout?.on('data', (chunk: Buffer) => {
      collector.push(chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 65536) stderr += chunk.toString('utf8');
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        clearTimeout(timeoutHandle);
        if (timedOut || signal === 'SIGKILL' || signal === 'SIGTERM') return resolve(-1);
        resolve(code ?? -1);
      });
    }).finally(() => clearTimeout(timeoutHandle));

    if (timedOut) {
      return {
        ok: false,
        summary: '类型检查超时',
        error: { code: 'TSC_TIMEOUT', kind: 'timeout', message: `tsc 超过 ${timeoutMs}ms 未完成` },
      };
    }

    collector.end();
    const { errors, total } = collector.result();

    if (exitCode === 0 && total === 0) {
      return {
        ok: true,
        summary: '类型干净：tsc --noEmit 无错误',
        data: { total: 0, errors: [], root: projectRoot },
      };
    }

    if (total > 0) {
      return {
        ok: false,
        summary: `类型错误 ${total} 处${total > errors.length ? `（仅列前 ${errors.length} 条）` : ''}`,
        error: {
          code: 'TYPE_ERRORS',
          kind: 'invalid_args',
          message: `tsc 报 ${total} 处类型错误，首条 ${errors[0]!.code} @ ${errors[0]!.file}:${errors[0]!.line}`,
        },
        data: { total, errors, root: projectRoot },
      };
    }

    // ④ 退出非 0 却没有诊断行：多半是配置/CLI 层错误（TS5057、TS18003 等），
    //    这类错误不能硬塞进 TYPE_ERRORS，否则 Agent 会去改源码而不是改配置。
    return {
      ok: false,
      summary: 'tsc 执行失败（无诊断输出）',
      error: {
        code: 'TSC_FAILED',
        kind: 'internal',
        message: tail(stderr) || `tsc 退出码 ${exitCode}，无输出`,
      },
      data: { exitCode, root: projectRoot },
    };
  },
};
