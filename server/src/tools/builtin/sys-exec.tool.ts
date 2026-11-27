/**
 * sys.exec — 在沙箱目录内执行白名单命令。
 *
 * 关键设计（每一条都是被真实攻防场景逼出来的）：
 *  - **不经 shell**：`spawn(cmd, args, { shell: false })`，`|` `&&` `>` `$( )` 是字面字符。
 *    要串联就分多次调用，不要自写 tokenizer（引号/转义/Windows 路径全是注入点）。
 *  - **不接受命令行字符串**：只收 `{ command, args[] }`，与 spawn 一一对应，零解析歧义。
 *  - **cwd 复用 path-jail**：越界/软链逃逸由 realpath 判定，不在这里重写一套校验。
 *  - **杀进程组**：`detached: true` + POSIX `kill(-pid)` / Windows `taskkill /T /F`。
 *    只杀父进程会留下孤儿子进程（`npm test` 派生的 node 会继续占端口/写文件，等于超时没生效）。
 *  - **退出码口径**：跑完即成功（含非 0 退出码）。`npm test` 返回 1 是「命令成功执行、
 *    测试失败」，记成 failed 会让 agent 以为工具坏了去重试编译。
 */

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import type { ToolDefinition, ToolOutcome } from '../../types/tool.js';
import { config } from '../../config/env.js';
import { resolveInSandboxAsync } from './path-jail.js';
import { killProcessTree } from './process-tree.js';
import {
  buildExecEnv,
  evaluateExecCommand,
  resolveExecTimeout,
  resolveExecutable,
} from './sys-exec.policy.js';

/** stdout 上限 8 KB、stderr 4 KB；头尾各保一半，绝不静默丢尾。 */
export const EXEC_STDOUT_CAP = 8192;
export const EXEC_STDERR_CAP = 4096;
/** 截断提示占用的预留空间（保证 head+tail+提示 仍在 cap 内）。 */
const TRUNCATE_NOTICE_RESERVE = 48;
/**
 * 杀掉进程组后等待 close 的兜底时长。
 * 不能太短：Windows 的 `taskkill /T /F` 在进程树较大/宿主较慢时要几秒才返回，
 * 抢跑会让我们在子进程真正退出前先结算（等于把「已杀干净」错报成「没杀干净」，
 * 而且会丢掉 stdout/stderr/pid —— 那正是事后审计要看的东西）。
 * 实测：本仓库的 CI 宿主上 taskkill 到子进程 close 约 11s（真机通常 <500ms），
 * 所以取 15s —— 宁可多等，也不要报一个假的「已终止」。
 */
const KILL_SETTLE_MS = 15000;

interface Sink {
  push: (chunk: Buffer) => void;
  text: () => string;
  readonly bytesTotal: number;
  readonly truncated: boolean;
}

/** 有界收集器：头部保一半、尾部保一半，中间省略并显式标记。 */
function makeSink(limitBytes: number): Sink {
  const usable = Math.max(0, limitBytes - TRUNCATE_NOTICE_RESERVE);
  const headLimit = Math.ceil(usable / 2);
  const tailLimit = usable - headLimit;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let total = 0;

  return {
    push(chunk: Buffer): void {
      total += chunk.length;
      let rest = chunk;
      if (head.length < headLimit) {
        const need = headLimit - head.length;
        head = Buffer.concat([head, rest.subarray(0, need)]);
        rest = rest.subarray(need);
      }
      if (rest.length > 0) {
        tail = Buffer.concat([tail, rest]);
        if (tail.length > tailLimit) tail = Buffer.from(tail.subarray(tail.length - tailLimit));
      }
    },
    text(): string {
      const headText = head.toString('utf8');
      const tailText = tail.toString('utf8');
      if (total <= limitBytes) return headText + tailText;
      return `${headText}\n…已截断 ${total - limitBytes} 字节…\n${tailText}`;
    },
    get bytesTotal(): number {
      return total;
    },
    get truncated(): boolean {
      return total > limitBytes;
    },
  };
}

function fail(
  code: string,
  kind: 'invalid_args' | 'security' | 'not_found' | 'timeout' | 'internal',
  message: string,
  suggestion?: string,
): ToolOutcome {
  return {
    ok: false,
    summary: message,
    error: { code, kind, message, suggestion, retryable: false },
  };
}

export const sysExecTool: ToolDefinition = {
  name: 'sys.exec',
  wireName: 'sys_exec',
  displayName: '执行命令',
  category: 'compute',
  description:
    '在沙箱目录内执行白名单命令。不做 shell 解释：args 按字面传参，`|` `&&` `>` `$( )` 是普通字符不会被解释；要串联请分多次调用。' +
    'command 只接受逻辑名（如 git / node），不接受路径；cwd 必须是沙箱内的已存在目录。' +
    'git 的 -c / -C / --exec-path / --upload-pack / --receive-pack / --config-env、filter-branch 的 *-filter、rebase --exec、bisect run、submodule foreach、filter-repo、config --global/--system/--file 都会被拒绝（它们可让 git 执行任意命令或访问沙箱外）；要换目录请用本工具的 cwd 参数。' +
    '退出码非 0 表示「命令跑完了、结果失败」，工具本身仍算执行成功，请看 data.exitCode。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '逻辑命令名（basename），如 git / node；不接受路径', maxLength: 64 },
      args: {
        type: 'array',
        description: '按字面传递的参数数组（不经 shell 解释）',
        items: { type: 'string', maxLength: 4096 },
        maxItems: 64,
      },
      cwd: { type: 'string', description: '沙箱内相对工作目录，缺省为沙箱根', maxLength: 512 },
      timeoutMs: { type: 'number', description: '超时（ms），受服务端硬上限约束', minimum: 1 },
    },
    required: ['command'],
    additionalProperties: false,
  },
  // executor 这层只管「别再往下等」；真正杀进程组的超时在 handler 内部，
  // 留 5s 余量让 handler 的 timeout 分支先结算（否则 executor 抢先返回，
  // 进程组就成了孤儿）。
  timeoutMs: config.execToolMaxTimeoutMs + 5000,
  risk: 'high',
  approvalMode: 'hard',
  source: 'builtin',
  idempotent: false,
  maxResultChars: EXEC_STDOUT_CAP + EXEC_STDERR_CAP + 2048,
  enabled: (ctx) => Boolean(ctx.sandboxRoot),
  handler: async (args, ctx): Promise<ToolOutcome> => {
    const commandRaw = String(args.command ?? '');
    const execArgs = Array.isArray(args.args) ? args.args.map((value) => String(value)) : [];

    // 第 1/2 层（gateway 已经跑过一次；这里是纵深，防 handler 被直接调用）。
    const policy = evaluateExecCommand(commandRaw, execArgs);
    if (!policy.ok) {
      return fail(
        policy.code === 'INVALID_ARGS' ? 'TOOL_INVALID_ARGS' : 'TOOL_SECURITY_DENIED',
        policy.code === 'INVALID_ARGS' ? 'invalid_args' : 'security',
        policy.message,
        policy.suggestion,
      );
    }

    // ── cwd：复用 path-jail，不重写校验 ──────────────────────────────────
    const cwdArg = args.cwd === undefined ? '.' : String(args.cwd);
    const jail = await resolveInSandboxAsync(ctx.sandboxRoot, cwdArg, false, undefined, ctx.allowedDirs);
    if (!jail.ok) {
      return fail('TOOL_SECURITY_DENIED', 'security', `工作目录被沙箱策略拒绝：${jail.message}`);
    }
    let cwdIsDir = false;
    try {
      // jail 只保证「在范围内」，不保证「是目录」——这条必须补。
      cwdIsDir = statSync(jail.absolutePath).isDirectory();
    } catch {
      return fail(
        'EXEC_CWD_NOT_FOUND',
        'not_found',
        `工作目录不存在：${jail.sandboxRelative}`,
        '先确认目录存在（可用 fs.list 查看沙箱内容）',
      );
    }
    if (!cwdIsDir) {
      return fail('TOOL_INVALID_ARGS', 'invalid_args', `cwd 不是目录：${jail.sandboxRelative}`);
    }

    // ── 可执行文件解析：白名单内的逻辑名 → PATH 上的绝对路径 ─────────────
    const execPath = resolveExecutable(policy.command);
    if (!execPath) {
      return fail(
        'EXEC_NOT_FOUND',
        'not_found',
        `命令 ${policy.command} 无法解析为可执行文件`,
        '该命令不在白名单或系统 PATH 中；Windows 下的 .cmd/.bat 需改由 node 直接调用脚本',
      );
    }

    let env: Record<string, string>;
    try {
      // command 传进去是为了让 git 分支注入 GIT_CONFIG_*（禁用 hooks），
      // 其他命令不受影响（见 sys-exec.policy.buildExecEnv 的 D 段注释）。
      env = buildExecEnv(process.env, { command: policy.command, sandboxRoot: ctx.sandboxRoot });
    } catch (err) {
      // 环境变量净化失败 = 有泄露风险，宁可拒绝执行。
      return fail('EXEC_ENV_REJECTED', 'security', err instanceof Error ? err.message : String(err));
    }

    const timeoutMs = resolveExecTimeout(args.timeoutMs);
    ctx.reportProgress('exec', `执行 ${policy.command}（${execArgs.length} 个参数，超时 ${timeoutMs}ms）`);

    return await new Promise<ToolOutcome>((resolve) => {
      const outSink = makeSink(EXEC_STDOUT_CAP);
      const errSink = makeSink(EXEC_STDERR_CAP);
      const startedAt = Date.now();
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let timer: NodeJS.Timeout | undefined;
      let settleGuard: NodeJS.Timeout | undefined;

      const child = spawn(execPath, execArgs, {
        cwd: jail.absolutePath,
        env,
        shell: false, // 硬约束：绝不解释 args
        windowsHide: true,
        detached: true, // 独立进程组，超时时才能整组杀掉
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const dataOf = (exitCode: number | null, signal: NodeJS.Signals | null): Record<string, unknown> => ({
        command: policy.command,
        args: execArgs,
        cwd: jail.sandboxRelative,
        exitCode,
        signal,
        pid: child.pid ?? null,
        stdout: outSink.text(),
        stderr: errSink.text(),
        truncated: outSink.truncated || errSink.truncated,
        bytesTotal: outSink.bytesTotal + errSink.bytesTotal,
        stdoutBytes: outSink.bytesTotal,
        stderrBytes: errSink.bytesTotal,
        durationMs: Date.now() - startedAt,
        timeoutMs,
      });

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        if (settleGuard) clearTimeout(settleGuard);
        ctx.signal.removeEventListener('abort', onAbort);
      };

      const onAbort = (): void => {
        if (settled) return;
        aborted = true;
        killProcessTree(child.pid);
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });

      const settle = (outcome: ToolOutcome): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      };

      child.stdout?.on('data', (chunk: Buffer) => outSink.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => errSink.push(chunk));

      // spawn 失败（ENOENT/EACCES）：进程零启动，这才是「工具失败」。
      child.on('error', (err: NodeJS.ErrnoException) => {
        const code = err.code === 'EACCES' ? 'EXEC_SPAWN_DENIED' : 'EXEC_NOT_FOUND';
        settle(
          fail(
            code,
            err.code === 'EACCES' ? 'security' : 'not_found',
            `启动 ${policy.command} 失败：${err.code ?? err.message}`,
            err.code === 'EACCES' ? '可执行文件没有执行权限' : '该命令不在白名单或系统 PATH 中',
          ),
        );
      });

      timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        killProcessTree(child.pid);
        // contract：kill 之后要等 close 再结算（否则 stdout 尾部会丢）。
        // 但 close 理论上可能不来（进程卡在不可中断状态），留个兜底。
        // 兜底也必须带 data —— pid / 已收集输出正是事后审计的凭据，丢了就查不出是谁没死。
        settleGuard = setTimeout(() => {
          // 兜底结算时 close 可能永远不来：已产出的部分输出必须随 data 一起交回，
          // 否则「跑对了但慢」与「卡死在第一步」在模型看来完全无差别。
          const partial = dataOf(null, null);
          const partialNote =
            outSink.bytesTotal + errSink.bytesTotal > 0
              ? `（超时前已产出 stdout ${outSink.bytesTotal}B / stderr ${errSink.bytesTotal}B，见 data.stdout / data.stderr）`
              : '（超时前没有任何输出）';
          settle({
            ok: false,
            summary: `命令执行超时（${timeoutMs}ms），已请求终止进程组但未等到退出事件${partialNote}`,
            data: partial,
            error: {
              code: 'EXEC_TIMEOUT',
              kind: 'timeout',
              message: `命令在 ${timeoutMs}ms 内未结束，已发送终止信号但未收到 close 事件${partialNote}`,
              suggestion:
                outSink.bytesTotal + errSink.bytesTotal > 0
                  ? '已有部分输出说明命令确实跑起来了、只是慢：缩小任务范围或调大 timeoutMs（受服务端硬上限约束）'
                  : '没有任何输出：可能卡在启动/首步，检查命令与参数是否会在无输入时阻塞',
              retryable: false,
            },
          });
        }, KILL_SETTLE_MS);
      }, timeoutMs);

      // 只认 close：exit 触发时 stdio 可能还有未读完的数据。
      child.on('close', (exitCode, signal) => {
        const data = dataOf(exitCode, signal);
        if (timedOut) {
          settle({
            ok: false,
            summary: `命令执行超时（${timeoutMs}ms），已终止进程组`,
            data,
            error: {
              code: 'EXEC_TIMEOUT',
              kind: 'timeout',
              message: `命令在 ${timeoutMs}ms 内未结束，已杀掉整个进程组`,
              suggestion: '缩小任务范围，或调大 timeoutMs（受服务端硬上限约束）',
              retryable: false,
            },
          });
          return;
        }
        if (aborted) {
          settle({
            ok: false,
            summary: '任务已中止，命令进程组已终止',
            data,
            error: { code: 'TOOL_ABORTED', kind: 'internal', message: '任务已被用户中止', retryable: false },
          });
          return;
        }
        // 跑完即成功 —— 含非 0 退出码（退出码进 data，判据层去看它）。
        settle({
          ok: true,
          summary: `命令已执行，退出码 ${exitCode ?? 'null（被信号终止）'}（stdout ${outSink.bytesTotal}B / stderr ${errSink.bytesTotal}B，耗时 ${Date.now() - startedAt}ms）`,
          data,
        });
      });
    });
  },
};
