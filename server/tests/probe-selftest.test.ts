/**
 * 合法调用探针闸的自证测试。
 *
 * 按宣言 C3：闸本身要能被打红。这里用两份探针（一份合法、一份被前置校验拒绝）
 * 直接调 probeCheck()，证明它确实分得开「会正确调用靶子」与「判据自己没走到被测行为」。
 *
 * bad 探针用的正是当初骗过 A3 的那组参数：把整条命令行塞进 command，
 * 工具前置策略拒成 security —— 那个假红让 Agent 白改了 3 轮。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { probeCheck } from '../scripts/auto-adopt.js';

const SERVER = process.cwd();
const DIR = path.join(SERVER, 'candidates');
// candidates/ 是运行时目录（auto-author 的产物池），新检出里不存在；测试自建。
mkdirSync(DIR, { recursive: true });
const GOOD = path.join(DIR, '__selftest_good.probe.ts');
const BAD = path.join(DIR, '__selftest_bad.probe.ts');

const HEAD = `
import { sysExecTool } from '../src/tools/builtin/sys-exec.tool.js';
export async function runProbe(): Promise<void> {
  const ctx = { sessionId: 's', toolCallId: 't', callId: 'c', iteration: 1,
    sandboxRoot: process.cwd(), signal: new AbortController().signal, reportProgress: () => {} };
`;

const TAIL = `
  const kind = r.error?.kind ?? 'ok';
  const premature = ['invalid_args', 'security', 'not_found', 'internal'].includes(kind);
  console.log('PROBE_RESULT=' + JSON.stringify({ reachedBehavior: !premature, kind, ok: r.ok }));
  if (premature) process.exit(2);
}
runProbe();
`;

afterAll(() => {
  for (const f of [GOOD, BAD]) if (existsSync(f)) rmSync(f, { force: true });
});

describe('A2.5 合法调用探针闸', { timeout: 180_000 }, () => {
  it('出题人写对参数 -> 放行', () => {
    writeFileSync(
      GOOD,
      HEAD +
        `  const r = await sysExecTool.handler!({ command: 'node', args: ['-e', 'console.log(1)'], timeoutMs: 5000 }, ctx);\n` +
        TAIL,
      'utf8',
    );
    const r = probeCheck(GOOD);
    expect(r.ok, r.reason).toBe(true);
    expect(r.reason).toContain('探针通过');
  });

  it('金丝雀：参数被前置校验拦住 -> 拒收（不许放过错尺子）', () => {
    writeFileSync(
      BAD,
      HEAD + `  const r = await sysExecTool.handler!({ command: 'node -e "console.log(1)"', timeoutMs: 5000 }, ctx);\n` + TAIL,
      'utf8',
    );
    const r = probeCheck(BAD);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('前置校验');
  });

  it('金丝雀：不真的调 handler、写死通过 -> 拒收', () => {
    const fake = path.join(DIR, '__selftest_fake.probe.ts');
    writeFileSync(
      fake,
      `console.log('PROBE_RESULT=' + JSON.stringify({ reachedBehavior: true, kind: 'ok' }));\n`,
      'utf8',
    );
    try {
      const r = probeCheck(fake);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('没有真的调用 handler');
    } finally {
      rmSync(fake, { force: true });
    }
  });
});
