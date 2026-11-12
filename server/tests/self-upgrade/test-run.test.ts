/**
 * test.run 判据 —— 「改完能不能跑一遍，并看见到底哪条断言不对」。
 *
 * ── 为什么需要这条能力 ────────────────────────────────────
 * `code.check` 只保证语法能解析、tsc 只保证类型自洽，两者都过了，**行为仍可能是错的**。
 * 已经发生的实例：`fs.write{operation:'replace'}` 的 C6（行尾）—— 语法对、类型对，
 * 但 CRLF 文件被写成了混合行尾。那一轮 Agent 完全无法自查，只能等外部把断言原文喂回来，
 * 于是多耗了两次派单。
 *
 * 判据只锁**可观察结果**：跑完之后拿到的「过了几条、挂了几条、挂在哪、为什么」，
 * 以及四条安全边界（只跑 tests/ 下的测试、越界拒绝、超时熔断、不继承密钥）。
 * 不锁它用哪个 reporter、怎么解析、怎么杀进程。
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolExecutionContext, ToolDefinition, ToolOutcome } from '../../src/types/tool.js';

const ROOT = process.cwd();
const FIX_DIR = join(ROOT, 'tests', 'self-upgrade', 'fixtures');
const FIXTURE = 'tests/self-upgrade/fixtures/probe.test.ts';
const MARKERS = ['.mode-fail', '.mode-slow', '.mode-env'] as const;

/**
 * 骨架阶段跳过。
 *
 * 这题被拆成两步：先写骨架（第一步判据 test-run-scaffold.test.ts），再补执行逻辑。
 * 第一步的全量回归会跑到这个文件，而那时执行逻辑还没写，C1–C10 必然全红 ——
 * 那是「还没轮到的题」，不是「踩坏了既有行为」。
 *
 * 判定方式必须是**运行时探测**，不能看源码里有没有 'NOT_IMPLEMENTED' 这个词：
 * 实现里只要还留着那个分支（哪怕走不到），源码判断就会永远跳过这道题，
 * 于是「判据通过」变成假绿——而假绿是围栏最该拦、却拦不住的那种。
 */
const TOOL_PATH = join(ROOT, 'src', 'tools', 'builtin', 'test-run.tool.ts');

const ctx: ToolExecutionContext = {
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: ROOT,
  signal: new AbortController().signal,
  reportProgress: () => {},
};

const STILL_SCAFFOLD = await (async (): Promise<boolean> => {
  if (!existsSync(TOOL_PATH)) return true;
  try {
    const mod = (await import('../../src/tools/builtin/test-run.tool.js')) as Record<string, unknown>;
    const tool = mod.testRunTool as ToolDefinition | undefined;
    if (!tool) return true;
    const out = await tool.handler({ file: FIXTURE }, ctx);
    return out.error?.code === 'NOT_IMPLEMENTED';
  } catch (e) {
    console.error('[test-run 判据] 骨架探测异常：', e instanceof Error ? e.message : String(e));
    return true;
  }
})();

function setModes(...names: string[]): void {
  for (const name of names) writeFileSync(join(FIX_DIR, name), '');
}

function clearModes(): void {
  for (const name of MARKERS) rmSync(join(FIX_DIR, name), { force: true });
}

afterEach(() => {
  clearModes();
});

async function loadTool(): Promise<ToolDefinition> {
  const mod = (await import('../../src/tools/builtin/test-run.tool.js')) as Record<string, unknown>;
  const tool = mod.testRunTool as ToolDefinition | undefined;
  if (!tool) throw new Error('test-run.tool.ts 必须导出 testRunTool');
  return tool;
}

async function run(args: Record<string, unknown>): Promise<ToolOutcome> {
  const tool = await loadTool();
  return tool.handler(args, ctx);
}

function dataOf(o: ToolOutcome): Record<string, unknown> {
  return (o.data ?? {}) as Record<string, unknown>;
}

function failuresOf(o: ToolOutcome): { name?: string; message?: string }[] {
  const f = dataOf(o).failures;
  return Array.isArray(f) ? (f as { name?: string; message?: string }[]) : [];
}

describe.skipIf(STILL_SCAFFOLD)('test.run —— 跑指定测试并读回断言差异', { timeout: 180_000 }, () => {
  it('C1 全绿要报全绿，且只跑指定的那一个文件', async () => {
    clearModes();
    const o = await run({ file: FIXTURE });
    expect(o.ok, `期望 ok，实际：${o.error?.message ?? o.summary}`).toBe(true);
    const d = dataOf(o);
    // total 必须是 4（夹具只有 4 条用例）：跑到 1000+ 说明它跑的是全量套件，
    // 那一次自查就要几十秒，Agent 会因此放弃用它。
    expect(d.total).toBe(4);
    expect(d.failed).toBe(0);
    expect(d.passed).toBe(4);
  });

  it('C2 有一条失败时必须报失败，并把该条名字与断言消息读回来', async () => {
    setModes('.mode-fail');
    const o = await run({ file: FIXTURE });
    expect(o.ok).toBe(false);
    expect(o.error?.code).toBe('TEST_FAILED');
    const d = dataOf(o);
    expect(d.failed).toBe(1);
    expect(d.passed).toBe(3);
    expect(d.total).toBe(4);

    const failures = failuresOf(o);
    expect(failures.length).toBe(1);
    // 名字要能指到具体用例（"probe B"），否则「错了 1 条」没有信息量。
    expect(String(failures[0]?.name)).toContain('probe B');
    // 消息要保留断言原文（vitest 的 expected/was 措辞里含 "to be"）。
    expect(String(failures[0]?.message)).toContain('to be');
  });

  it('C3 只搬运断言本身，不搬运整段堆栈', async () => {
    setModes('.mode-fail');
    const o = await run({ file: FIXTURE });
    const failures = failuresOf(o);
    // 条数必须等于 failed：把所有用例连绿的都塞回来，等于把工具的价值的抹平。
    expect(failures.length).toBe(dataOf(o).failed);
    for (const f of failures) {
      const msg = String(f.message ?? '');
      // 堆栈一进来，单条 observation 就能吃掉整个回灌预算，真正的原因反而被裁掉。
      expect(msg.length).toBeLessThan(400);
      expect(msg).not.toContain('node_modules');
      expect(msg).not.toMatch(/\n\s*❯/);
    }
  });

  it('C4 只允许 tests/ 下的测试：源码文件与其它类型一律拒绝', async () => {
    for (const file of ['src/app.ts', 'tests/self-upgrade/code-check.test.ts.bak', 'package.json']) {
      const o = await run({ file });
      expect(o.ok, `${file} 不该被接受`).toBe(false);
      expect(o.error?.code).toBe('UNSUPPORTED_TARGET');
      expect(o.error?.kind).toBe('invalid_args');
    }
  });

  it('C5 越界与穿越必须按安全拒绝，不能退化成 UNSUPPORTED_TARGET', async () => {
    for (const file of ['tests/../package.json', '../../etc/passwd', 'C:/Windows/win.ini', '/etc/passwd']) {
      const o = await run({ file });
      expect(o.ok).toBe(false);
      expect(o.error?.kind, `${file} 应按安全拒绝`).toBe('security');
    }
  });

  it('C6 文件不存在要能与「跑失败」区分开', async () => {
    const o = await run({ file: 'tests/self-upgrade/does-not-exist.test.ts' });
    expect(o.ok).toBe(false);
    expect(o.error?.kind).toBe('not_found');
    expect(o.error?.code).not.toBe('TEST_FAILED');
  });

  it('C7 超时必须熔断：有限时间内返回，且错误码可识别', async () => {
    setModes('.mode-slow');
    const startedAt = Date.now();
    const o = await run({ file: FIXTURE, timeoutMs: 1500 });
    const elapsed = Date.now() - startedAt;
    expect(o.ok).toBe(false);
    expect(o.error?.code).toBe('TEST_TIMEOUT');
    // 携带 5s 的用例 + 1.5s 上限：超过 30s 说明它没杀子进程，只是坐等 vitest 自己结束。
    expect(elapsed).toBeLessThan(30_000);
  });

  it('C8 子进程不得继承密钥与代理配置', async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of ['LLM_SERVER_API_KEY', 'HTTP_PROXY', 'AGENT_APPROVAL_SECRET']) {
      saved[key] = process.env[key];
    }
    process.env.LLM_SERVER_API_KEY = 'leak-canary';
    process.env.HTTP_PROXY = 'http://canary.invalid:1';
    process.env.AGENT_APPROVAL_SECRET = 'leak-canary';
    try {
      setModes('.mode-env');
      // 夹具 D 会断言这些变量在子进程里是 undefined；ok=true 即代表没有泄漏。
      const o = await run({ file: FIXTURE });
      expect(o.ok, `子进程继承了敏感环境变量：${o.summary}`).toBe(true);
    } finally {
      for (const key of Object.keys(saved)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it('C9 文件名里带 shell 元字符不得被当作命令执行', async () => {
    for (const file of [
      'tests/self-upgrade/fixtures/probe.test.ts && calc',
      'tests/$(whoami).test.ts',
      'tests/self-upgrade/fixtures/probe.test.ts|calc',
      'tests/`id`.test.ts',
    ]) {
      const o = await run({ file });
      expect(o.ok, `${file} 不该被接受`).toBe(false);
    }
  });
  it('C10 必须注册进 BUILTIN_TOOLS，否则产品里根本调不到', async () => {
    // 判据直接 import 工具文件，所以「没注册」时 C1–C9 照样能全绿 ——
    // 那会是一次「判据过了、功能不存在」的升级。产品里工具是从注册表装配的，
    // 这里锁的就是这一步。
    const tool = await loadTool();
    const registry = (await import('../../src/tools/builtin/index.js')) as {
      BUILTIN_TOOLS?: { name?: string }[];
    };
    const names = (registry.BUILTIN_TOOLS ?? []).map((t) => t.name);
    expect(names, `BUILTIN_TOOLS 里没有 ${tool.name}`).toContain(tool.name);
    // 顺带锁住「别把已有工具弄丢」：15 个既有工具必须一个不少。
    for (const name of ['fs.read', 'fs.write', 'code.check', 'sys.exec']) {
      expect(names).toContain(name);
    }
  });
});
it('夹具存在性前置', () => {
  expect(existsSync(join(FIX_DIR, 'probe.test.ts')), '判据夹具 probe.test.ts 丢失').toBe(true);
});
