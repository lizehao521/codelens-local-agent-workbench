import { fsReadTool } from '../src/tools/builtin/fs-read.tool.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export async function runProbe(): Promise<void> {
  // 沙箱根 = 受控临时目录，文件落根内、相对路径传入（path-jail 拒绝绝对路径）。
  const sandbox = mkdtempSync(join(tmpdir(), 'fs-read-probe-'));
  const ctx = {
    sessionId: 's',
    toolCallId: 't',
    callId: 'c',
    iteration: 1,
    sandboxRoot: sandbox,
    signal: new AbortController().signal,
    reportProgress: () => {},
  };

  const relPath = `fs-read-probe-${randomUUID()}.txt`;
  writeFileSync(join(sandbox, relPath), Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n') + '\n');

  const r = await fsReadTool.handler!({ path: relPath, lineStart: 1, lineEnd: 10 }, ctx);
  rmSync(sandbox, { recursive: true, force: true });
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
