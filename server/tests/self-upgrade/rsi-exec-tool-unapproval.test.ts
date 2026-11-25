import { describe, it, expect } from 'vitest';
import { BUILTIN_TOOLS } from '../../src/tools/builtin/index.js';

const ctx = {
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: process.cwd(),
  signal: new AbortController().signal,
  reportProgress: () => {},
};

const rsiExecTool = BUILTIN_TOOLS.find((t) => t.name === 'rsi.exec');

describe('rsi.exec tool registration and behavior', () => {
  it('should be registered in BUILTIN_TOOLS with approvalMode none', () => {
    expect(rsiExecTool).toBeDefined();
    expect(rsiExecTool!.approvalMode).toBe('none');
  });

  it('should execute allowlisted command successfully', async () => {
    const result = await rsiExecTool!.handler!({ command: 'node', args: ['--version'] }, ctx);
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
  });

  it('should reject non-allowlisted command', async () => {
    const result = await rsiExecTool!.handler!({ command: 'ls', args: ['-la'] }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(['security', 'invalid_args']).toContain(result.error!.kind);
  });

  it('should reject timeoutMs exceeding 60000', async () => {
    const result = await rsiExecTool!.handler!({ command: 'node', args: ['--version'], timeoutMs: 70000 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.kind).toBe('invalid_args');
  });
});

describe('通用安全断言（rsi.exec 口径）', () => {
  it('必须注册进 BUILTIN_TOOLS 且 approvalMode=none', async () => {
    const { BUILTIN_TOOLS } = (await import('../../src/tools/builtin/index.js')) as {
      BUILTIN_TOOLS: { name?: string; approvalMode?: string }[]
    };
    const def = BUILTIN_TOOLS.find((t) => t.name === 'rsi.exec');
    expect(def, 'BUILTIN_TOOLS 必须注册 rsi.exec').toBeTruthy();
    expect(def!.approvalMode).toBe('none');
  });

  it('非法命令与非白名单必须被拒绝', async () => {
    const { BUILTIN_TOOLS } = (await import('../../src/tools/builtin/index.js')) as {
      BUILTIN_TOOLS: { name?: string; handler?: (a: Record<string, unknown>, c: unknown) => Promise<{ ok: boolean }> }[]
    };
    const def = BUILTIN_TOOLS.find((t) => t.name === 'rsi.exec');
    const ctx = {
      sessionId: 's', toolCallId: 't', callId: 'c', iteration: 1,
      sandboxRoot: process.cwd(), signal: new AbortController().signal, reportProgress: () => {},
    };
    for (const bad of ['ls', 'bash', 'sh', 'curl', '/etc/passwd', '../node']) {
      const out = await def!.handler!({ command: bad, args: [] }, ctx);
      expect(out.ok, '非白名单命令 ' + bad + ' 不该被接受').toBe(false);
    }
  });

  it('timeoutMs 超过 60000 必须被拒绝', async () => {
    const { BUILTIN_TOOLS } = (await import('../../src/tools/builtin/index.js')) as {
      BUILTIN_TOOLS: { name?: string; handler?: (a: Record<string, unknown>, c: unknown) => Promise<{ ok: boolean; error?: { kind?: string } }> }[]
    };
    const def = BUILTIN_TOOLS.find((t) => t.name === 'rsi.exec');
    const ctx = {
      sessionId: 's', toolCallId: 't', callId: 'c', iteration: 1,
      sandboxRoot: process.cwd(), signal: new AbortController().signal, reportProgress: () => {},
    };
    const out = await def!.handler!({ command: 'node', args: ['--version'], timeoutMs: 70000 }, ctx);
    expect(out.ok).toBe(false);
    expect(out.error?.kind).toBe('invalid_args');
  });
});
