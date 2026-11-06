/**
 * `sys.exec` 命令执行工具：安全契约的执行侧破坏夹具（E1–E11）。
 *
 * 这些用例刻意围绕「攻破方式」写，而不是围绕「功能」写：
 *  - E1/E2 越权：白名单外命令、越界 cwd 必须**连进程都不启动**；
 *  - E3/E9 超时：必须杀掉**整个进程组**（只杀父进程 = 超时没生效）；
 *  - E4 截断：8 KB 上限仍然能拿到真实字节数，且不静默丢尾；
 *  - E5 不经 shell：`; rm -rf` 是普通字符串；
 *  - E6 环境隔离：子进程拿不到 `*_KEY / *_SECRET / *_TOKEN`；
 *  - E7 审批不可豁免：三个自动放行全开也照样 hard；
 *  - E8 退出码口径：非 0 退出码仍是「命令执行成功」；
 *  - E11 two_step 只升不降。
 *
 * 说明：spawn 被包了一层计数代理（vi.mock + importOriginal），
 * 这样「拒绝时零启动」是可断言的，而不是靠日志猜。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolExecutionContext } from '../src/types/tool.js';

const spawnLog = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      spawnLog.calls.push(args);
      return (actual.spawn as unknown as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const { sysExecTool, EXEC_STDOUT_CAP } = await import('../src/tools/builtin/sys-exec.tool.js');
const { evaluateExecCommand, buildExecEnv } = await import('../src/tools/builtin/sys-exec.policy.js');
const { assessRisk, runGateway, exemptCategory } = await import('../src/services/tools/security-gateway.js');
const { toolSuccessRate, DEFAULT_L0_THRESHOLDS } = await import('../src/services/judge/criteria.js');
const { ToolExecutor } = await import('../src/services/tools/executor.service.js');

let sandbox: string;
let ctx: ToolExecutionContext;

/**
 * 宿主机是否真的装了 git。
 * 真实 spawn git 的用例在「没装 git」的机器上必然失败——那是环境缺失，不是产品缺陷；
 * 显式 skip 并在报告里说明，比让整套测试变红更能反映真实质量。
 */
const GIT_AVAILABLE: boolean = (() => {
  try {
    const r = spawnSync('git', ['--version'], { stdio: 'ignore', timeout: 10_000, windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
})();

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'sysexec-'));
  ctx = {
    sessionId: 's',
    toolCallId: 't',
    callId: 'c',
    iteration: 1,
    sandboxRoot: sandbox,
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
});

afterEach(() => {
  // 清理推到 setImmediate：宿主删除守卫在同步路径上可能超时，
  // 而它耗时会被算进 hook 超时，把已通过的用例判红。清理是 best-effort。
  const dir = sandbox;
  setImmediate(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 残留由环境侧回收 */
    }
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程还在，只是没权限给它发信号
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitPidGone(pid: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isAlive(pid)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 最小 executor 夹具（与 executor.service.test.ts 同构，只是把仓储/审批/SSE 压成内存桩）。
 * 用它断言用户真正看得见的 `ToolStatus`，而不是只断言 handler 的 error.kind。
 */
function makeExecutorHarness(root: string) {
  const rows: Array<Record<string, unknown>> = [];
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  const toolCalls = {
    insert: (row: unknown) => {
      rows.push(row as Record<string, unknown>);
      return row;
    },
    listBySession: () => rows,
    markRunning: () => undefined,
    markFinished: (id: string, patch: Record<string, unknown>) => {
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
    },
  };
  const toolResults = {
    insert: (fields: Record<string, unknown>) => ({ id: `tr_${rows.length}`, created_at: Date.now(), ...fields }),
  };
  const approvals = { hasSessionGrant: () => false, requestApproval: async () => 'allow_once' };
  const executor = new ToolExecutor({
    toolCalls: toolCalls as never,
    toolResults: toolResults as never,
    approvals: approvals as never,
    sse: { emit: (name: string, data: unknown) => events.push({ name, data: data as Record<string, unknown> }) } as never,
    sandboxRoot: root,
    allowedDirs: [],
    canRetry: () => false,
    onRetryConsumed: () => undefined,
  });
  return { executor, rows, events };
}

function execToolCallRow(callId: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `tc_${callId}`,
    session_id: 'sess_exec',
    message_id: 'msg_1',
    call_id: callId,
    tool_name: 'sys.exec',
    tool_wire_name: 'sys_exec',
    display_name: '执行命令',
    category: 'compute',
    source: 'builtin',
    risk: 'high',
    approval_mode: 'hard',
    channel: 'native',
    iteration: 1,
    args_json: JSON.stringify(args),
    args_digest: 'digest',
    status: 'pending',
    error_kind: null,
    error_msg: null,
    result_ref: null,
    result_summary: null,
    truncated: 0,
    started_at: null,
    ended_at: null,
    duration_ms: 0,
    created_at: Date.now(),
  };
}

describe('sys.exec · E1 白名单外命令（进程零启动）', () => {
  it('bash 在 gateway 层就被拒，且没有 spawn 发生', async () => {
    const before = spawnLog.calls.length;
    const r = runGateway(sysExecTool, { command: 'bash', args: ['-c', 'echo hi'] }, { sandboxRoot: sandbox });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SECURITY_DENIED');
    expect(spawnLog.calls.length).toBe(before);
  });

  it('直接调 handler 也拒绝（纵深：handler 不依赖 gateway 已跑过）', async () => {
    const before = spawnLog.calls.length;
    const r = await sysExecTool.handler({ command: 'bash', args: ['-c', 'touch pwned'] }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('TOOL_SECURITY_DENIED');
    expect(spawnLog.calls.length).toBe(before);
    expect(existsSync(join(sandbox, 'pwned'))).toBe(false);
  });

  it('白名单内没有的命令（python）同样 SECURITY_DENIED', () => {
    const r = runGateway(sysExecTool, { command: 'python', args: ['-c', 'print(1)'] }, { sandboxRoot: sandbox });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SECURITY_DENIED');
  });

  it('command 传路径一律 INVALID_ARGS（不允许执行沙箱里刚写出来的文件）', () => {
    for (const command of ['./evil-git', 'C:\\tmp\\git.exe', '..\\git', '/usr/bin/git']) {
      const r = runGateway(sysExecTool, { command }, { sandboxRoot: sandbox });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
    }
  });

  it('空白名单 = 全拒（fail-closed，不继承「0 = 不限」惯例）', () => {
    const r = evaluateExecCommand('git', ['status'], []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SECURITY_DENIED');
  });

  it('Windows 脚本形态（.cmd/.bat）直接拒绝并说明替代方式', () => {
    const r = evaluateExecCommand('npm.cmd', ['run', 'build'], ['npm.cmd']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('SECURITY_DENIED');
      expect(r.suggestion ?? '').toContain('node');
    }
  });
});

describe('sys.exec · E2 cwd 越界', () => {
  it("cwd '../' 在 gateway 层被拒", () => {
    const r = runGateway(sysExecTool, { command: 'git', args: ['status'], cwd: '../' }, { sandboxRoot: sandbox });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SECURITY_DENIED');
  });

  it('沙箱外的绝对路径 cwd 被拒（handler 层同样拒绝）', async () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    const before = spawnLog.calls.length;
    const r = await sysExecTool.handler({ command: 'git', args: ['status'], cwd: outside }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('TOOL_SECURITY_DENIED');
    expect(spawnLog.calls.length).toBe(before);
  });
});

describe('sys.exec · E3 超时杀进程', () => {
  it(
    'node 挂起 60s + 超时 200ms → timeout，且该 pid 已不存在',
    { timeout: 60_000 },
    async () => {
      const r = await sysExecTool.handler(
        { command: 'node', args: ['-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 200 },
        ctx,
      );
      expect(r.ok).toBe(false);
      // executor 的 kind→status 映射：timeout → status 'timeout'
      expect(r.error?.kind).toBe('timeout');
      const pid = r.data?.pid;
      expect(typeof pid).toBe('number');
      expect(await waitPidGone(pid as number)).toBe(true);
    },
  );
});

describe('sys.exec · E3b executor 级：用户可见的 status 就是 timeout', () => {
  it(
    '超时后 executor 落库/推送的 ToolStatus === timeout（不只是 error.kind）',
    { timeout: 120_000 },
    async () => {
      const h = makeExecutorHarness(sandbox);
      const args = { command: 'node', args: ['-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 200 };
      const toolCall = execToolCallRow('call_timeout', args) as never;
      h.rows.push(toolCall as unknown as Record<string, unknown>);

      const outcomes = await h.executor.executeBatch([
        {
          toolCall,
          definition: sysExecTool,
          args,
          digest: 'digest',
          verdict: { risk: 'high', approvalMode: 'hard' },
          channel: 'native',
          iteration: 1,
        },
      ]);

      const outcome = outcomes.get('call_timeout');
      // 卡片与判据塔读的都是这个字段
      expect(outcome?.status).toBe('timeout');
      expect(outcome?.errorKind).toBe('timeout');
      const resultEvent = h.events.find((e) => e.name === 'tool_result');
      expect(resultEvent?.data.status).toBe('timeout');
    },
  );
});

describe('sys.exec · E4 输出截断', () => {
  it('100 KB stdout → truncated=true、返回体 ≤ 8 KB、bytesTotal 是真实值', { timeout: 30_000 }, async () => {
    const r = await sysExecTool.handler(
      { command: 'node', args: ['-e', "process.stdout.write('x'.repeat(100000))"] },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.data?.truncated).toBe(true);
    expect(r.data?.bytesTotal).toBe(100000);
    const stdout = String(r.data?.stdout ?? '');
    expect(Buffer.byteLength(stdout, 'utf8')).toBeLessThanOrEqual(EXEC_STDOUT_CAP);
    // 头尾都保留：既不是空串，也不是只有头部
    expect(stdout.startsWith('x')).toBe(true);
    expect(stdout.trimEnd().endsWith('x')).toBe(true);
  });
});

describe('sys.exec · E5 不经 shell（元字符是字面量）', () => {
  it.skipIf(!GIT_AVAILABLE)("git 收到 'x; rm -rf <probe>' 后探针文件仍存在", { timeout: 30_000 }, async () => {
    const probe = join(sandbox, 'probe.txt');
    writeFileSync(probe, 'keep me');
    const r = await sysExecTool.handler({ command: 'git', args: ['-m', `x; rm -rf ${probe}`] }, ctx);
    // git 会因为非法用法返回非 0，但那仍然属于「命令执行成功」
    expect(r.ok).toBe(true);
    expect(existsSync(probe)).toBe(true);
  });
});

describe('sys.exec · E5b git 参数级命令执行开关（白名单内的一击即穿）', () => {
  it("git -c core.pager='echo pwned' → 拒绝，且进程零启动", async () => {
    const args = ['-c', 'core.pager=echo pwned', 'log'];
    const before = spawnLog.calls.length;
    const gate = runGateway(sysExecTool, { command: 'git', args }, { sandboxRoot: sandbox });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('SECURITY_DENIED');
    expect(spawnLog.calls.length).toBe(before);

    const direct = await sysExecTool.handler({ command: 'git', args }, ctx);
    expect(direct.ok).toBe(false);
    expect(direct.error?.code).toBe('TOOL_SECURITY_DENIED');
    expect(direct.error?.suggestion ?? '').toContain('git -c <key>=<value>');
    expect(spawnLog.calls.length).toBe(before);
  });

  it('git --exec-path=/tmp → 拒绝（换掉子命令加载目录）', () => {
    const gate = runGateway(sysExecTool, { command: 'git', args: ['--exec-path=/tmp', 'log'] }, { sandboxRoot: sandbox });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('SECURITY_DENIED');
  });

  it('--upload-pack / --receive-pack / --config-env= / -c 附着形式 全覆盖', () => {
    const dangerous = [
      ['--upload-pack=/tmp/evil', 'fetch'],
      ['--receive-pack=/tmp/evil', 'push'],
      ['--config-env=core.pager=EVIL', 'log'],
      ['-ccore.pager=evil', 'log'],
      ['--exec=/tmp/evil', 'log'],
    ];
    for (const args of dangerous) {
      const r = evaluateExecCommand('git', args);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('SECURITY_DENIED');
    }
  });

  it('正常 git 用法不被误伤（status / log --oneline / diff / commit -m）', () => {
    const allowed = [['status'], ['log', '--oneline'], ['diff'], ['commit', '-m', 'fix bug']];
    for (const args of allowed) {
      const r = evaluateExecCommand('git', args);
      expect(r.ok).toBe(true);
      const gate = runGateway(sysExecTool, { command: 'git', args }, { sandboxRoot: sandbox });
      expect(gate.ok).toBe(true);
    }
  });
});

describe('sys.exec · E5c A 类：git 子命令参数执行（filter-branch / rebase --exec / bisect run …）', () => {
  it('filter-branch 的六个 *-filter 全部拒绝', () => {
    const flags = [
      '--tree-filter',
      '--index-filter',
      '--msg-filter',
      '--parent-filter',
      '--commit-filter',
      '--tag-name-filter',
    ];
    for (const flag of flags) {
      for (const arg of [flag, `${flag}=echo pwned`]) {
        const before = spawnLog.calls.length;
        const gate = runGateway(
          sysExecTool,
          { command: 'git', args: ['filter-branch', arg, 'HEAD'] },
          { sandboxRoot: sandbox },
        );
        expect(gate.ok, `${flag} 应被拒绝`).toBe(false);
        if (!gate.ok) expect(gate.code).toBe('SECURITY_DENIED');
        expect(spawnLog.calls.length).toBe(before);
      }
    }
  });

  it('rebase --exec / -x / --exec=… 全部拒绝', () => {
    for (const args of [['rebase', '--exec', 'echo pwned'], ['rebase', '-x', 'echo pwned'], ['rebase', '--exec=echo pwned', 'HEAD~1']]) {
      const r = evaluateExecCommand('git', args);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('SECURITY_DENIED');
    }
  });

  it('bisect run / submodule foreach / filter-repo 拒绝', () => {
    const denied = [
      ['bisect', 'run', './script.mjs'],
      ['submodule', 'foreach', 'rm -rf .'],
      ['filter-repo', '--force'],
    ];
    for (const args of denied) {
      const r = evaluateExecCommand('git', args);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('SECURITY_DENIED');
    }
  });

  it('防误伤：log --follow / rebase --continue / bisect good / submodule status 仍放行', () => {
    const allowed = [
      ['log', '--follow'],
      ['rebase', '--continue'],
      ['bisect', 'good'],
      ['submodule', 'status'],
    ];
    for (const args of allowed) {
      const r = evaluateExecCommand('git', args);
      expect(r.ok, `${args.join(' ')} 应放行`).toBe(true);
      const gate = runGateway(sysExecTool, { command: 'git', args }, { sandboxRoot: sandbox });
      expect(gate.ok, `${args.join(' ')} 应放行`).toBe(true);
    }
  });
});

describe('sys.exec · E5d B 类：git -C 一律拒绝（绕过 cwd jail）', () => {
  it('git -C sub status 与 git -C /tmp status 都拒绝', () => {
    for (const target of ['sub', '/tmp', 'C:\\Windows', '../..']) {
      const before = spawnLog.calls.length;
      const r = runGateway(sysExecTool, { command: 'git', args: ['-C', target, 'status'] }, { sandboxRoot: sandbox });
      expect(r.ok, `-C ${target} 应被拒绝`).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('SECURITY_DENIED');
        expect(r.message).toContain('-C');
      }
      expect(spawnLog.calls.length).toBe(before);
    }
  });

  it('拒绝理由是「用工具 cwd 参数」（可执行替代方案）', () => {
    const r = evaluateExecCommand('git', ['-C', '../..', 'status']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.suggestion ?? '').toContain('cwd');
  });

  it('--git-dir / --work-tree 同类拒绝（同属越狱面）', () => {
    for (const args of [['--git-dir=/tmp/evil.git', 'status'], ['--work-tree=/tmp', 'status']]) {
      const r = evaluateExecCommand('git', args);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('SECURITY_DENIED');
    }
  });
});

describe('sys.exec · E5e C 类：git config 不得写沙箱外', () => {
  it('--global / --system / --file / -f 拒绝', () => {
    const denied = [
      ['config', '--global', 'core.pager', 'evil'],
      ['config', '--system', 'core.sshCommand', 'evil'],
      ['config', '--file', '/tmp/x.gitconfig', 'core.pager', 'evil'],
      ['config', '-f', '/tmp/x.gitconfig', 'core.pager', 'evil'],
    ];
    for (const args of denied) {
      const r = evaluateExecCommand('git', args);
      expect(r.ok, args.join(' ')).toBe(false);
      if (!r.ok) expect(r.code).toBe('SECURITY_DENIED');
    }
  });

  it('只读形态与本地写入仍放行（--get / --list / 不带作用域）', () => {
    for (const args of [['config', '--get', 'user.name'], ['config', '--list'], ['config', 'user.name', 'x']]) {
      const r = evaluateExecCommand('git', args);
      expect(r.ok, args.join(' ')).toBe(true);
    }
  });

  it('⑤b 本地作用域的「配置即命令」键同样拒绝（alias !cmd / core.sshCommand …）', () => {
    const denied = [
      ['config', 'alias.x', '!sh -c "evil"'],
      ['config', 'core.sshCommand', '/tmp/evil'],
      ['config', 'core.fsmonitor', '/tmp/evil'],
      ['config', 'diff.external', '/tmp/evil'],
      ['config', 'core.pager', 'less'],
    ];
    for (const args of denied) {
      const r = evaluateExecCommand('git', args);
      expect(r.ok, args.join(' ')).toBe(false);
      if (!r.ok) expect(r.code).toBe('SECURITY_DENIED');
    }
    // 无害 alias（不以 ! 开头）与读取仍然放行
    for (const args of [['config', 'alias.st', 'status'], ['config', '--get', 'core.pager'], ['config', '--get', 'alias.x']]) {
      const r = evaluateExecCommand('git', args);
      expect(r.ok, args.join(' ')).toBe(true);
    }
  });
});

describe('sys.exec · E5f D 类：git 执行时中和「配置即命令」的三个键', () => {
  const disabledPath = () => join(sandbox, '.codelens-no-hooks');

  it('buildExecEnv 对 git 注入 3 个键：hooksPath / diff.external / core.pager', () => {
    const env = buildExecEnv(process.env, { command: 'git', sandboxRoot: sandbox });
    expect(env.GIT_CONFIG_COUNT).toBe('3');
    expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
    expect(env.GIT_CONFIG_VALUE_0).toBe(disabledPath());
    expect(env.GIT_CONFIG_KEY_1).toBe('diff.external');
    expect(env.GIT_CONFIG_VALUE_1).toBe(disabledPath());
    expect(env.GIT_CONFIG_KEY_2).toBe('core.pager');
    expect(env.GIT_CONFIG_VALUE_2).toBe('');
    // 指向的路径必须真的不存在（存在就等于把 hooks「指到了一个真目录」）
    expect(existsSync(env.GIT_CONFIG_VALUE_0)).toBe(false);
    // 仍然不泄露密钥
    expect(Object.keys(env).some((k) => /(_KEY|_SECRET|_TOKEN)$/i.test(k))).toBe(false);
  });

  it('非 git 命令不注入这些键（避免污染 node 的执行环境）', () => {
    const env = buildExecEnv(process.env, { command: 'node', sandboxRoot: sandbox });
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  it.skipIf(!GIT_AVAILABLE)(
    '端到端：git 自己读到的三个值就是注入值（证明通道真生效，不是写了没人读）',
    { timeout: 120_000 },
    async () => {
      const hooks = await sysExecTool.handler({ command: 'git', args: ['config', '--get', 'core.hooksPath'] }, ctx);
      expect(hooks.ok).toBe(true);
      expect(String(hooks.data?.stdout ?? '').trim()).toBe(disabledPath());

      // diff.external 是「普通 git diff 就会执行」的那条路径，必须单独验
      const diff = await sysExecTool.handler({ command: 'git', args: ['config', '--get', 'diff.external'] }, ctx);
      expect(diff.ok).toBe(true);
      expect(String(diff.data?.stdout ?? '').trim()).toBe(disabledPath());

      // core.pager 被置空：git 认为「已配置但为空」⇒ 不分页（--get 通常输出空行、退出码 0）
      const pager = await sysExecTool.handler({ command: 'git', args: ['config', '--get', 'core.pager'] }, ctx);
      expect(pager.ok).toBe(true);
      expect(pager.data?.exitCode).toBe(0);
      expect(String(pager.data?.stdout ?? '').trim()).toBe('');
    },
  );
});

describe('sys.exec · E5g 拉起宿主程序的子命令被拒', () => {
  it('instaweb / web--browse / gui / citool 拒绝，git help -w 与 --web 拒绝', () => {
    const denied = [['instaweb'], ['web--browse', 'https://x.test'], ['gui'], ['citool'], ['help', '-w', 'commit'], ['help', '--web', 'commit']];
    for (const args of denied) {
      const before = spawnLog.calls.length;
      const r = runGateway(sysExecTool, { command: 'git', args }, { sandboxRoot: sandbox });
      expect(r.ok, args.join(' ')).toBe(false);
      if (!r.ok) expect(r.code).toBe('SECURITY_DENIED');
      expect(spawnLog.calls.length).toBe(before);
    }
  });

  it('git help <cmd>（不带 -w）仍放行', () => {
    const r = evaluateExecCommand('git', ['help', 'commit']);
    expect(r.ok).toBe(true);
  });
});

describe('sys.exec · E6 环境变量白名单构造', () => {
  it('子进程看不到 *_KEY / *_SECRET / *_TOKEN，也看不到 LLM_SERVER_API_KEY 的值', { timeout: 30_000 }, async () => {
    const original = process.env.LLM_SERVER_API_KEY;
    process.env.LLM_SERVER_API_KEY = 'leak-me-123456';
    try {
      const script =
        "process.stdout.write(JSON.stringify({" +
        "secrets: Object.keys(process.env).filter((k) => /_KEY|_SECRET|_TOKEN/i.test(k))," +
        "probe: process.env.LLM_SERVER_API_KEY ?? null" +
        '}))';
      const r = await sysExecTool.handler({ command: 'node', args: ['-e', script] }, ctx);
      expect(r.ok).toBe(true);
      const stdout = String(r.data?.stdout ?? '');
      expect(stdout).not.toContain('leak-me-123456');
      const parsed = JSON.parse(stdout) as { secrets: string[]; probe: string | null };
      expect(parsed.secrets).toEqual([]);
      expect(parsed.probe).toBeNull();
    } finally {
      if (original === undefined) delete process.env.LLM_SERVER_API_KEY;
      else process.env.LLM_SERVER_API_KEY = original;
    }
  });
});

describe('sys.exec · E7 审批不可被豁免', () => {
  it('三个自动放行全开 + exec 调用 → verdict 仍是 hard', () => {
    const allOn = { fsDestructive: true, purge: true, httpWrite: true };
    const v = assessRisk(sysExecTool, { command: 'git', args: ['status'] }, { sandboxRoot: sandbox, exemptions: allOn });
    expect(v.risk).toBe('high');
    expect(v.approvalMode).toBe('hard');
    const g = runGateway(
      sysExecTool,
      { command: 'git', args: ['status'] },
      { sandboxRoot: sandbox, exemptions: allOn },
    );
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.verdict.approvalMode).toBe('hard');
  });

  it('exemptCategory 对 sys.exec 恒为 null（结构上无法豁免）', () => {
    expect(exemptCategory('sys.exec')).toBeNull();
    expect(exemptCategory('sys.exec', { command: 'node', args: ['-e', '1'] })).toBeNull();
  });
});

describe('sys.exec · E8 退出码口径', () => {
  it('node -e process.exit(1) → ok:true、exitCode 1', { timeout: 30_000 }, async () => {
    const r = await sysExecTool.handler({ command: 'node', args: ['-e', 'process.exit(1)'] }, ctx);
    expect(r.ok).toBe(true);
    expect(r.data?.exitCode).toBe(1);
    expect(r.summary).toContain('退出码 1');
  });

  it('L0 tool.success_rate 读 exitCode：非 0 不算成功', { timeout: 30_000 }, () => {
    const base = {
      sessionId: 's',
      finishReason: 'stop',
      iteration: 1,
      tokenBudget: 100000,
      usage: { promptTokens: 10, completionTokens: 5 },
      approvals: [],
      circuitOpened: false,
    };
    const allZero = toolSuccessRate(
      { ...base, toolCalls: [{ status: 'success', display_name: '执行命令', exit_code: 0 }] },
      DEFAULT_L0_THRESHOLDS,
    );
    expect(allZero.score).toBe(1);

    const nonZero = toolSuccessRate(
      {
        ...base,
        toolCalls: [
          { status: 'success', display_name: '执行命令', exit_code: 1 },
          { status: 'success', display_name: '读取文件' },
        ],
      },
      DEFAULT_L0_THRESHOLDS,
    );
    expect(nonZero.score).toBe(0.5);
    expect(nonZero.detail ?? '').toContain('退出码非 0');
  });
});

describe('sys.exec · E9 进程组（孙进程不留孤儿）', () => {
  it('父进程派生孙进程后被超时杀掉，孙进程同样消失', { timeout: 120_000 }, async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const grand = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
      "fs.writeFileSync('grand.pid', String(grand.pid));",
      'setTimeout(() => {}, 60000);',
    ].join('');
    const r = await sysExecTool.handler({ command: 'node', args: ['-e', script], timeoutMs: 800 }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('timeout');

    const pidFile = join(sandbox, 'grand.pid');
    expect(existsSync(pidFile)).toBe(true);
    const grandPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(grandPid)).toBe(true);
    // 全量并行时 Windows 进程回收会明显变慢（实测 8s 不够），放宽等待窗口但不放宽断言
    expect(await waitPidGone(grandPid, 20_000)).toBe(true);
  });
});

describe('sys.exec · E10 正常路径', () => {
  // 两次真实 spawn（git init + git status）。本机 git 单次 0.7–3s，
  // 但 CI 宿主上有进程 shim，spawn 开销会放大到数秒；给足环境时间。
  it.skipIf(!GIT_AVAILABLE)('git status 在合法 cwd → ok、exitCode 0、有 stdout', { timeout: 120_000 }, async () => {
    const init = await sysExecTool.handler({ command: 'git', args: ['init'] }, ctx);
    expect(init.ok).toBe(true);

    const r = await sysExecTool.handler({ command: 'git', args: ['status'] }, ctx);
    expect(r.ok).toBe(true);
    expect(r.data?.exitCode).toBe(0);
    expect(String(r.data?.stdout ?? '').length).toBeGreaterThan(0);
    expect(r.data?.cwd).toBe('.');
  });
});

describe('sys.exec · E11 two_step 只升不降', () => {
  const gctx = () => ({ sandboxRoot: sandbox });

  it('node 任何调用都是 two_step', () => {
    const v = assessRisk(sysExecTool, { command: 'node', args: ['-e', 'console.log(1)'] }, gctx());
    expect(v.risk).toBe('high');
    expect(v.approvalMode).toBe('two_step');
  });

  it('git status 是 hard（不是 two_step），本地不可逆操作与出网操作是 two_step', () => {
    const status = assessRisk(sysExecTool, { command: 'git', args: ['status'] }, gctx());
    expect(status.approvalMode).toBe('hard');
    for (const args of [['reset', '--hard'], ['clean', '-fd']]) {
      const v = assessRisk(sysExecTool, { command: 'git', args }, gctx());
      expect(v.approvalMode).toBe('two_step');
    }
    // E 类：出网一律人确认（不拒，因为拉取仓库是合理需求）
    for (const args of [
      ['clone', 'https://x.test/r.git'],
      ['fetch', 'origin'],
      ['pull'],
      ['push'],
      ['ls-remote', 'origin'],
      ['submodule', 'update', '--init'],
      // add 与 update 同为出网 + 写 .gitmodules，只升 update 会留下换入口就绕过的缺口
      ['submodule', 'add', 'https://x.test/r.git'],
      ['archive', '--remote=https://x.test/r.git', 'HEAD'],
      ['send-email', 'HEAD~1'],
      ['daemon', '--port=9000'],
      ['http-backend'],
      ['request-pull', 'HEAD~1', 'https://x.test/r.git'],
    ]) {
      const v = assessRisk(sysExecTool, { command: 'git', args }, gctx());
      expect(v.approvalMode, args.join(' ')).toBe('two_step');
    }
    // 本地 archive 只读，不该被升档
    const localArchive = assessRisk(sysExecTool, { command: 'git', args: ['archive', '-o', 'x.tar', 'HEAD'] }, gctx());
    expect(localArchive.approvalMode).toBe('hard');
  });
});
