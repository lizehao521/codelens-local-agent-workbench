import { fsListTool } from '../src/tools/builtin/fs-list.tool.js';

export async function runProbe(): Promise<void> {
  const ctx = { sessionId: 's', toolCallId: 't', callId: 'c', iteration: 1,
    sandboxRoot: process.cwd(), signal: new AbortController().signal, reportProgress: () => {} };
  const r = await fsListTool.handler!({ path: '.', recursive: true }, ctx);
  const kind = r.error?.kind ?? 'ok';
  const premature = ['invalid_args', 'security', 'not_found', 'internal'].includes(kind);
  console.log('PROBE_RESULT=' + JSON.stringify({
    reachedBehavior: !premature, kind, ok: r.ok,
    message: String(r.error?.message ?? '').slice(0, 160),
  }));
  if (premature) process.exit(2);
}
runProbe();
