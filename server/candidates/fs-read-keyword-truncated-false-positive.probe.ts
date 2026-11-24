import { fsReadTool } from '../src/tools/builtin/fs-read.tool.js';
import { writeFileSync, rmSync } from 'node:fs';

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
  const probePath = 'probe-fs-read-keyword.txt';
  writeFileSync(probePath, 'alpha\nbeta\nalpha\n', 'utf8');
  try {
    const r = await fsReadTool.handler!({ path: probePath, keyword: 'alpha' }, ctx);
    const kind = r.error?.kind ?? 'ok';
    const premature = ['invalid_args', 'security', 'not_found', 'internal'].includes(kind);
    console.log('PROBE_RESULT=' + JSON.stringify({
      reachedBehavior: !premature,
      kind,
      ok: r.ok,
      message: String(r.error?.message ?? '').slice(0, 160),
    }));
    if (premature) process.exit(2);
  } finally {
    rmSync(probePath, { force: true });
  }
}
runProbe();
