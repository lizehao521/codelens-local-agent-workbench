import { fsReadTool } from '../src/tools/builtin/fs-read.tool.js';
import { writeFileSync, unlinkSync } from 'node:fs';

export async function runProbe(): Promise<void> {
  const ctx = { sessionId: 's', toolCallId: 't', callId: 'c', iteration: 1,
    sandboxRoot: process.cwd(), signal: new AbortController().signal, reportProgress: () => {} };
  const fileName = 'probe-fs-read-oob-line-window.txt';
  writeFileSync(fileName, 'line1\nline2\nline3\nline4\nline5\n', 'utf8');
  try {
    const r = await fsReadTool.handler!({ path: fileName, lineStart: 10, lineEnd: 20 }, ctx);
    const kind = r.error?.kind ?? 'ok';
    const premature = ['invalid_args', 'security', 'not_found', 'internal'].includes(kind);
    console.log('PROBE_RESULT=' + JSON.stringify({
      reachedBehavior: !premature, kind, ok: r.ok,
      message: String(r.error?.message ?? '').slice(0, 160),
    }));
    if (premature) process.exit(2);
  } finally {
    try { unlinkSync(fileName); } catch {}
  }
}
runProbe();
