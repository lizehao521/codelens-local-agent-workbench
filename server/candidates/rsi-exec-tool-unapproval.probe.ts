import { BUILTIN_TOOLS } from '../src/tools/builtin/index.js';

const rsiExecTool = BUILTIN_TOOLS.find((t) => t.name === 'rsi.exec');

export async function runProbe(): Promise<void> {
  const ctx = {
    sessionId: 's',
    toolCallId: 't',
    callId: 'c',
    iteration: 1,
    sandboxRoot: process.cwd(),
    signal: new AbortController().signal,
    reportProgress: () => {},
  };

  if (!rsiExecTool) {
    console.log('PROBE_RESULT=' + JSON.stringify({ reachedBehavior: false, kind: 'not_found', ok: false, message: 'rsi.exec tool not registered' }));
    process.exit(2);
  }

  const r = await rsiExecTool.handler!({ command: 'node', args: ['--version'] }, ctx);
  const kind = r.error?.kind ?? 'ok';
  const premature = ['invalid_args', 'security', 'not_found', 'internal'].includes(kind);
  console.log('PROBE_RESULT=' + JSON.stringify({
    reachedBehavior: !premature,
    kind,
    ok: r.ok,
    message: String(r.error?.message ?? '').slice(0, 160),
  }));
  if (premature) process.exit(2);
}

runProbe();
