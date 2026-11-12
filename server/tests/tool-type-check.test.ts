/**
 * type.check —— 「Agent 能不能自己验类型」的判据。
 *
 * ── 缺陷现场 ──────────────────────────────────────────────
 * `code.check` 只把单文件喂给 `stripTypeScriptTypes`：它验**语法**，不验类型。
 * 类型错了它报「语法正确」。Agent 想自证类型干净只剩 `sys.exec`，而 `sys.exec`
 * 每次都要人批 → 它倾向绕开验证、直接宣称改完。
 *
 * ── 这条判据锁什么 ────────────────────────────────────────
 *   1. tsc 输出解析：Windows 盘符路径不会被 `:` 切错；非诊断行不计入；
 *   2. 真能跑：沙箱是空目录、root 指向仓库时，对仓库跑出「0 错误」；
 *   3. 三种失败态各归各位：缺 tsconfig / 缺 typescript / 配置错 → 不同错误码，
 *      **不能**都退化成「类型错误」，否则 Agent 会去改源码而不是改配置；
 *   4. 真错误能被抓到：临时项目里放一个 TS2322，必须报出来且带位置。
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { typeCheckTool, parseTscOutput, DiagnosticCollector } from '../src/tools/builtin/type-check.tool.js';
import type { ToolExecutionContext } from '../src/types/tool.js';

const ROOT = process.cwd(); // = server/

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
  emptySandbox = mkdtempSync(path.join(tmpdir(), 'empty-sandbox-'));
});

afterEach(() => {
  try {
    rmSync(emptySandbox, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test-cleanup] 清理失败（不影响结论）:', err instanceof Error ? err.message : err);
  }
});

describe('parseTscOutput：只认诊断行，位置不能切错', () => {
  it('Windows 盘符路径里的冒号不会被当成列分隔', () => {
    const out = parseTscOutput(
      'C:\\repo\\src\\a.ts(3,7): error TS2322: Type \'string\' is not assignable to type \'number\'.\n',
    );
    expect(out.total).toBe(1);
    expect(out.errors[0]).toEqual({
      file: 'C:\\repo\\src\\a.ts',
      line: 3,
      column: 7,
      code: 'TS2322',
      message: "Type 'string' is not assignable to type 'number'.",
    });
  });

  it('非诊断行（提示、空行、CRLF）不计入 total', () => {
    const out = parseTscOutput([
      'src/b.ts(1,1): error TS1005: \';\' expected.\r',
      '',
      'Found 1 error in 1 file.',
      'src/c.ts(2,2): warning TS9999: 不是 error，玩法不同',
    ].join('\r\n'));
    expect(out.total).toBe(1);
    expect(out.errors).toHaveLength(1);
  });

  it('超过 limit 时 total 仍报真实总数，只截断列表', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts(1,1): error TS2322: boom`);
    const out = parseTscOutput(lines.join('\n'), 20);
    expect(out.total).toBe(30);
    expect(out.errors).toHaveLength(20);
  });
});

describe('DiagnosticCollector：流式计数不许少报', () => {
  it('行被切在两个 chunk 之间也能拼回', () => {
    const c = new DiagnosticCollector(5);
    c.push('src/a.ts(1,1): error TS23');
    c.push('22: boom\nsrc/b.ts(2,2): error TS1005: x\n');
    c.end();
    const r = c.result();
    expect(r.total).toBe(2);
    expect(r.errors.map((e) => e.code)).toEqual(['TS2322', 'TS1005']);
  });

  it('输出远超旧 256KB 上限时仍全量计数（旧实现会在此少报）', () => {
    const c = new DiagnosticCollector(20);
    const line = 'src/f.ts(1,1): error TS2322: x\n';
    const chunk = line.repeat(10_000); // ~330KB，已越过旧实现的 262144 字符上限
    for (let i = 0; i < 5; i++) c.push(chunk);
    c.end();
    const r = c.result();
    expect(r.total).toBe(50_000);
    expect(r.errors).toHaveLength(20);
  });

  it('末尾无换行的最后一行也不丢', () => {
    const c = new DiagnosticCollector(5);
    c.push('src/a.ts(3,7): error TS2322: boom');
    c.end();
    expect(c.result().total).toBe(1);
  });
});

describe('type.check：谁能当根、失败了指向哪', () => {
  it('沙箱是空目录 + root=仓库时，真的跑通并报 0 错误', async () => {
    const out = await typeCheckTool.handler({ root: ROOT }, ctxWith());
    expect(out.ok, `期望类型干净，实际：${out.error?.message ?? out.summary}`).toBe(true);
    expect((out.data as { total: number }).total).toBe(0);
  }, 120_000);

  it('根下没有 tsconfig.json → TSCONFIG_MISSING（不是 TYPE_ERRORS）', async () => {
    const fakeRoot = mkdtempSync(path.join(tmpdir(), 'no-tsconfig-'));
    try {
      const out = await typeCheckTool.handler(
        { root: fakeRoot },
        ctxWith({ allowedDirs: [fakeRoot] }),
      );
      expect(out.ok).toBe(false);
      expect(out.error?.code).toBe('TSCONFIG_MISSING');
      expect(out.error?.kind).toBe('invalid_args');
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it('有 tsconfig 但没有 typescript 依赖 → TSC_MISSING（指「根错了」）', async () => {
    const fakeRoot = mkdtempSync(path.join(tmpdir(), 'no-typescript-'));
    try {
      writeFileSync(path.join(fakeRoot, 'tsconfig.json'), '{"include":["a.ts"]}');
      writeFileSync(path.join(fakeRoot, 'a.ts'), 'export const a = 1;\n');
      const out = await typeCheckTool.handler(
        { root: fakeRoot },
        ctxWith({ allowedDirs: [fakeRoot] }),
      );
      expect(out.ok).toBe(false);
      expect(out.error?.code).toBe('TSC_MISSING');
      expect(out.error?.message).toContain('typescript');
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it('root 指向授权范围外的目录 → 按安全拒绝，不进子进程', async () => {
    const stranger = mkdtempSync(path.join(tmpdir(), 'stranger-'));
    try {
      const out = await typeCheckTool.handler({ root: stranger }, ctxWith());
      expect(out.ok).toBe(false);
      expect(out.error?.kind).toBe('security');
    } finally {
      rmSync(stranger, { recursive: true, force: true });
    }
  });
});

describe('type.check：真类型错误必须被抓到', () => {
  it('临时项目里一个 TS2322 → ok:false + TYPE_ERRORS + 文件:行:列', async () => {
    const proj = mkdtempSync(path.join(tmpdir(), 'typed-proj-'));
    try {
      // 复用一个真实 typescript 安装（junction / dir symlink），不复制 22MB。
      const tsPkg = path.join(ROOT, 'node_modules', 'typescript');
      mkdirSync(path.join(proj, 'node_modules'), { recursive: true });
      symlinkSync(tsPkg, path.join(proj, 'node_modules', 'typescript'), process.platform === 'win32' ? 'junction' : 'dir');

      writeFileSync(
        path.join(proj, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { target: 'ES2022', module: 'nodenext', moduleResolution: 'nodenext', strict: true, noEmit: true, types: [] },
          include: ['bad.ts'],
        }),
      );
      writeFileSync(path.join(proj, 'bad.ts'), 'const n: number = "not a number";\nexport { n };\n');

      const out = await typeCheckTool.handler(
        { root: proj },
        ctxWith({ allowedDirs: [proj] }),
      );
      expect(out.ok, `期望抓到类型错误，实际：${out.summary}`).toBe(false);
      expect(out.error?.code).toBe('TYPE_ERRORS');
      const data = out.data as { total: number; errors: Array<{ code: string; file: string; line: number }> };
      expect(data.total).toBeGreaterThanOrEqual(1);
      expect(data.errors[0]!.code).toBe('TS2322');
      expect(data.errors[0]!.file.endsWith('bad.ts')).toBe(true);
      expect(data.errors[0]!.line).toBe(1);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }, 120_000);
});
