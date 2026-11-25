import { describe, expect, it } from 'vitest';
import { sysExecTool } from '../src/tools/builtin/sys-exec.tool.js';

function makeCtx(signal: AbortSignal) {
  return {
    sessionId: 'test-session',
    toolCallId: 'test-call',
    callId: 'test-call-id',
    iteration: 1,
    sandboxRoot: process.cwd(),
    signal,
    reportProgress: () => {},
  };
}

describe('sysExecTool timeout settle abort behavior', () => {
  it('executes simple command successfully', async () => {
    const ctx = makeCtx(new AbortController().signal);
    const result = await sysExecTool.handler!({
      command: 'node',
      args: ['-e', 'console.log("hello")'],
      timeoutMs: 5000,
    }, ctx);
    expect(result.ok).toBe(true);
  });

  it('returns timeout error when command exceeds timeoutMs', async () => {
    const ctx = makeCtx(new AbortController().signal);
    const result = await sysExecTool.handler!({
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 1e6)'],
      timeoutMs: 100,
    }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('timeout');
  });

  it('returns internal error with aborted message when aborted during settle period after internal timeout', async () => {
    const controller = new AbortController();
    const ctx = makeCtx(controller.signal);
    const promise = sysExecTool.handler!({
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 1e6)'],
      timeoutMs: 100,
    }, ctx);
    await new Promise(resolve => setTimeout(resolve, 200));
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('internal');
    expect(result.error?.message).toContain('aborted');
  }, 20000);
});

describe('通用安全断言（模板生成，不经模型）', () => {
  it('必须导出命名约定的对象', async () => {
    const mod = (await import('../src/tools/builtin/sys-exec.tool.js')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    expect(exported, 'src/tools/builtin/sys-exec.tool.ts 必须导出一个工具定义').toBeTruthy();
    const def = exported as { name?: string; wireName?: string; inputSchema?: unknown };
    expect(typeof def.name).toBe('string');
    expect(typeof def.wireName).toBe('string');
  });

  it('必须注册进 BUILTIN_TOOLS（否则产品里调不到）', async () => {
    const mod = (await import('../src/tools/builtin/sys-exec.tool.js')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    const def = exported as { name?: string };
    const registry = (await import('../src/tools/builtin/index.js')) as unknown as { BUILTIN_TOOLS?: { name?: string }[] };
    const names = (registry.BUILTIN_TOOLS ?? []).map((t) => t.name);
    expect(names, 'sys-exec.tool 没有注册进 BUILTIN_TOOLS').toContain(def.name);
  });

  it('非法输入必须被拒绝，且不得越出沙箱', async () => {
    const mod = (await import('../src/tools/builtin/sys-exec.tool.js')) as Record<string, unknown>;
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
