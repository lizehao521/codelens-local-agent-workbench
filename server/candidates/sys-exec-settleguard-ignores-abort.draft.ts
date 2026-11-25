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
