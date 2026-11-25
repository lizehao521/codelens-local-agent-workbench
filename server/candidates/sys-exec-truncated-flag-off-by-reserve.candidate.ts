import { describe, expect, it } from 'vitest';
import { sysExecTool } from '../src/tools/builtin/sys-exec.tool.js';

describe('sys.exec truncated flag in reserved interval', () => {
  const ctx = {
    sessionId: 's',
    toolCallId: 't',
    callId: 'c',
    iteration: 1,
    sandboxRoot: process.cwd(),
    signal: new AbortController().signal,
    reportProgress: () => {},
  };

  it('returns truncated=true when stdout exceeds usable limit (8150 > 8192-48)', async () => {
    // 8150 bytes: exceeds usable (8144) but not hard cap (8192)
    const cmd = `printf '%0.sx' {1..8150}`;
    const r = await sysExecTool.handler!({ command: 'bash', args: ['-c', cmd] }, ctx);

    expect(r.ok).toBe(true);
    expect(r.data).toBeDefined();
    const data = r.data as Record<string, unknown>;
    expect(data.truncated).toBe(true);
    expect(typeof data.stdout).toBe('string');
    expect((data.stdout as string).length).toBeLessThanOrEqual(8144);
    expect(String(data.stdout)).toContain('[truncated');
  });

  it('returns truncated=false when stdout fits within usable limit', async () => {
    // 8000 bytes: well within usable (8144)
    const cmd = `printf '%0.sx' {1..8000}`;
    const r = await sysExecTool.handler!({ command: 'bash', args: ['-c', cmd] }, ctx);

    expect(r.ok).toBe(true);
    expect(r.data).toBeDefined();
    const data = r.data as Record<string, unknown>;
    expect(data.truncated).toBe(false);
    expect(typeof data.stdout).toBe('string');
    expect((data.stdout as string).length).toBe(8000);
  });

  it('returns error for invalid command', async () => {
    const r = await sysExecTool.handler!({ command: 'this_command_does_not_exist_12345' }, ctx);

    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(['not_found', 'invalid_args', 'internal']).toContain(r.error!.kind);
  });
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
