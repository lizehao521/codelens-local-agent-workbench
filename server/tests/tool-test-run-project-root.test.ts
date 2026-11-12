/**
 * test.run 的项目根（project root）—— 修的是「被测对象从头到尾是错的」。
 *
 * ── 缺陷现场 ──────────────────────────────────────────────
 * 原实现把 vitest 二进制与子进程 cwd 都钉在 `ctx.sandboxRoot`。生产部署里
 * 沙箱根是 `server/workspace`（Agent 的读写地盘），**仓库在它外面**。
 * 于是「跑测试」实际是在一个空目录里跑，读不到报告就报 REPORT_READ_FAILED，
 * 而真实原因（根传错了）被掩盖。四轮派单里它一次都没能对仓库自证，这就是根因。
 *
 * ── 这条判据锁什么 ────────────────────────────────────────
 *   1. 沙箱是空目录、root 指向仓库时，**真的能跑通并读到断言结果**；
 *   2. root 必须是沙箱/授权目录/授权目录的上级，随便指一个外部目录要按安全拒绝；
 *   3. 根下没有 vitest 时要报「根传错了」（VITEST_MISSING），
 *      不能退化成含糊的 REPORT_READ_FAILED —— 错误码指向错的地方，比不报错更贵。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testRunTool } from '../src/tools/builtin/test-run.tool.js';
import { resolveProjectRoot } from '../src/tools/builtin/path-jail.js';
import type { ToolExecutionContext } from '../src/types/tool.js';

const ROOT = process.cwd();
// 用专属夹具：probe.test.ts 会写 .mode-* 标记，与 test-run.test.ts 并发会互踩。
const FIXTURE = 'tests/self-upgrade/fixtures/root-probe.test.ts';

let emptySandbox: string;

const ctxWith = (over: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: emptySandbox,
  allowedDirs: [path.join(ROOT, 'src')],
  signal: new AbortController().signal,
  reportProgress: () => {},
  ...over,
});

beforeEach(() => {
  // 一个真实存在、但完全没有项目的目录 —— 复刻生产里 server/workspace 的状态。
  emptySandbox = mkdtempSync(path.join(tmpdir(), 'empty-sandbox-'));
});

afterEach(() => {
  try {
    rmSync(emptySandbox, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test-cleanup] 清理失败（不影响结论）:', err instanceof Error ? err.message : err);
  }
});

describe('resolveProjectRoot：谁能当项目根', () => {
  it('授权目录的上级可以当根（src 被授权 → server 可作根）', async () => {
    const r = await resolveProjectRoot(emptySandbox, ROOT, [path.join(ROOT, 'src')]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.absolutePath.toLowerCase()).toBe(realpathSync(ROOT).toLowerCase());
  });

  it('授权目录本身也可以当根', async () => {
    const src = path.join(ROOT, 'src');
    const r = await resolveProjectRoot(emptySandbox, src, [src]);
    expect(r.ok).toBe(true);
  });

  it('沙箱内的目录本来就合法（不破坏原行为）', async () => {
    const r = await resolveProjectRoot(emptySandbox, '.', [path.join(ROOT, 'src')]);
    expect(r.ok).toBe(true);
  });

  it('既不在沙箱、也不沾授权目录的根 → 拒绝', async () => {
    const stranger = mkdtempSync(path.join(tmpdir(), 'stranger-'));
    try {
      const r = await resolveProjectRoot(emptySandbox, stranger, [path.join(ROOT, 'src')]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('PATH_OUTSIDE_SANDBOX');
    } finally {
      rmSync(stranger, { recursive: true, force: true });
    }
  });
});

describe('test.run：沙箱是空目录时，靠 root 跑通仓库测试', () => {
  it('不传 root 时空沙箱里连测试文件都不在 → NOT_FOUND（而不是含糊的 REPORT_READ_FAILED）', async () => {
    const out = await testRunTool.handler({ file: FIXTURE }, ctxWith());
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('NOT_FOUND');
  });

  it('根下没有 vitest → VITEST_MISSING，错误码指向「根错了」', async () => {
    // 造一个只有 tests/、没有 node_modules 的「假项目根」：
    // 这正是「根传错」的典型形态，报错必须直接说是缺依赖，不能是「报告读不到」。
    const fakeRoot = mkdtempSync(path.join(tmpdir(), 'fake-project-'));
    try {
      const dir = path.join(fakeRoot, 'tests');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'probe.test.ts'), 'import { it, expect } from "vitest";\nit("x", () => expect(1).toBe(1));\n');

      const out = await testRunTool.handler(
        { file: 'tests/probe.test.ts', root: fakeRoot },
        ctxWith({ allowedDirs: [fakeRoot] }),
      );
      expect(out.ok).toBe(false);
      expect(out.error?.code).toBe('VITEST_MISSING');
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it('传 root=仓库后真的跑起来，4 条断言全绿', async () => {
    const out = await testRunTool.handler({ file: FIXTURE, root: ROOT }, ctxWith());
    expect(out.ok, `期望通过，实际：${out.error?.message ?? out.summary}`).toBe(true);
    const d = out.data as { total: number; passed: number; failed: number };
    expect(d.total).toBe(4);
    expect(d.passed).toBe(4);
    expect(d.failed).toBe(0);
  }, 60_000);

  it('root 指向授权范围外的目录 → 按安全拒绝，不进子进程', async () => {
    const stranger = mkdtempSync(path.join(tmpdir(), 'stranger-'));
    try {
      const out = await testRunTool.handler({ file: FIXTURE, root: stranger }, ctxWith());
      expect(out.ok).toBe(false);
      expect(out.error?.kind).toBe('security');
    } finally {
      rmSync(stranger, { recursive: true, force: true });
    }
  });
});
