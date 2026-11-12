import { describe, expect, it } from 'vitest';
import { sysExecTool } from '../../src/tools/builtin/sys-exec.tool.js';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

function makeCtx() {
  return {
    sessionId: 'test-session',
    toolCallId: 'test-call',
    callId: 'test-call-id',
    iteration: 1,
    sandboxRoot: process.cwd(),
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
}

describe('sysExecTool 超时保留部分输出', () => {
  it('成功路径：正常命令返回完整输出', async () => {
    const result = await sysExecTool.handler!(
      { command: 'node', args: ['-e', 'console.log("hello-world")'], timeoutMs: 5000 },
      makeCtx()
    );
    expect(result.ok).toBe(true);
    expect(result.data?.stdout).toContain('hello-world');
  });

  it('超时路径：先打印再 sleep 的命令，超时结果包含已打印的部分', async () => {
    // command 是 basename，参数必须进 args（工具不做 shell 解释）。
    // 上一版把整条命令行塞进 command，被前置策略拦成 invalid_args —— 判据根本没测到超时行为。
    const result = await sysExecTool.handler!(
      { command: 'node', args: ['-e', "console.log('partial-output-123'); setTimeout(()=>{}, 10000)"], timeoutMs: 1000 },
      makeCtx()
    );
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('timeout');
    expect(result.data?.stdout).toContain('partial-output-123');
  });

  it('超时路径：stderr 部分输出同样保留', async () => {
    const result = await sysExecTool.handler!(
      { command: 'node', args: ['-e', "console.error('stderr-partial-456'); setTimeout(()=>{}, 10000)"], timeoutMs: 1000 },
      makeCtx()
    );
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('timeout');
    expect(result.data?.stderr).toContain('stderr-partial-456');
  });

  it('错误路径：命令不存在返回非超时错误', async () => {
    const result = await sysExecTool.handler!(
      { command: 'definitely-not-a-real-command-xyz', args: [], timeoutMs: 5000 },
      makeCtx()
    );
    expect(result.ok).toBe(false);
    // 真实 kind 只有 invalid_args / security / not_found / timeout / internal；
    // 上一版期望的 command_failed 是出题人编的，永远不可能满足。
    expect(['security', 'not_found', 'invalid_args']).toContain(result.error?.kind);
  });
});

describe('通用安全断言（模板生成，不经模型）', () => {
  it('必须导出命名约定的对象', async () => {
    const mod = (await import('../../src/tools/builtin/sys-exec.tool.js')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    expect(exported, 'src/tools/builtin/sys-exec.tool.ts 必须导出一个工具定义').toBeTruthy();
    const def = exported as { name?: string; wireName?: string; inputSchema?: unknown };
    expect(typeof def.name).toBe('string');
    expect(typeof def.wireName).toBe('string');
  });

  it('必须注册进 BUILTIN_TOOLS（否则产品里调不到）', async () => {
    const mod = (await import('../../src/tools/builtin/sys-exec.tool.js')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    const def = exported as { name?: string };
    const registry = (await import('../../src/tools/builtin/index.js')) as unknown as { BUILTIN_TOOLS?: { name?: string }[] };
    const names = (registry.BUILTIN_TOOLS ?? []).map((t) => t.name);
    expect(names, 'sys-exec.tool 没有注册进 BUILTIN_TOOLS').toContain(def.name);
  });

  it('非法输入必须被拒绝，且不得越出沙箱', async () => {
    const mod = (await import('../../src/tools/builtin/sys-exec.tool.js')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    const def = exported as { handler?: (a: Record<string, unknown>, c: unknown) => Promise<{ ok: boolean }> };
    expect(typeof def.handler).toBe('function');
    const ctx = {
      sessionId: 's', toolCallId: 't', callId: 'c', iteration: 1,
      sandboxRoot: process.cwd(), signal: new AbortController().signal, reportProgress: () => {},
    };
    for (const bad of ['../package.json', 'C:/Windows/win.ini', '/etc/passwd', '']) {
      const out = await def.handler!({ path: bad, file: bad }, ctx);
      expect(out.ok, "越界输入 " + bad + " 不该被接受").toBe(false);
    }
  });
});
