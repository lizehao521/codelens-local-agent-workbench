import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from '../src/tools/builtin/index.js';

const createCtx = () => ({
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: process.cwd(),
  signal: new AbortController().signal,
  reportProgress: () => {},
});

describe('rsi.exec tool registration and behavior', () => {
  it('should be registered in BUILTIN_TOOLS with approvalMode none', () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === 'rsi.exec');
    expect(tool).toBeDefined();
    expect(tool?.approvalMode).toBe('none');
  });

  it('should execute whitelisted command successfully', async () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === 'rsi.exec');
    expect(tool).toBeDefined();

    const ctx = createCtx();
    const result = await tool!.handler!({ command: 'node', args: ['--version'], timeoutMs: 10000 }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(typeof result.data?.stdout).toBe('string');
    expect(result.data?.stdout.length).toBeGreaterThan(0);
  });

  it('should reject non-whitelisted command', async () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === 'rsi.exec');
    expect(tool).toBeDefined();

    const ctx = createCtx();
    const result = await tool!.handler!({ command: 'rm', args: ['-rf', '/'], timeoutMs: 10000 }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(['security', 'invalid_args']).toContain(result.error?.kind);
  });

  it('should reject timeoutMs exceeding 60000', async () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === 'rsi.exec');
    expect(tool).toBeDefined();

    const ctx = createCtx();
    const result = await tool!.handler!({ command: 'node', args: ['--version'], timeoutMs: 60001 }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.kind).toBe('invalid_args');
  });
});
