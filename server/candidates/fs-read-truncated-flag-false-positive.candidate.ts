import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { fsReadTool } from '../src/tools/builtin/fs-read.tool.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// 沙箱根 = 受控临时目录，用例文件落在根内、以相对路径传入。
// path-jail 拒绝绝对路径（无 allowedDirs 时），写 OS 临时目录再传绝对路径
// 会被安全闸拒掉——判据就会红在 ok:false 而不是 truncated 语义上，修对了也绿不了。
let sandbox: string;
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'fs-read-judge-'));
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const ctx = () => ({
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: sandbox,
  signal: new AbortController().signal,
  reportProgress: () => {},
});

function createTestFile(lines: number): string {
  const name = `fs-read-test-${randomUUID()}.txt`;
  writeFileSync(join(sandbox, name), Array.from({ length: lines }, (_, i) => `Line ${i + 1}`).join('\n') + '\n');
  return name;
}

describe('fsReadTool explicit line window truncated flag', () => {
  // A3 要求模型断言在基线上全红：只钉缺陷本身。字节截断/非法参数的回归保护
  // 由围栏 --full 的既有用例承担，不写进判据（基线绿的断言会被判成快照拒收）。
  it('returns truncated:false when user explicitly requests a line window smaller than file', async () => {
    const relPath = createTestFile(100);
    const result = await fsReadTool.handler!({ path: relPath, lineStart: 1, lineEnd: 10 }, ctx());
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    // lines 是 {returned, total} 对象，不是数组
    const lines = result.data!.lines as { returned: number; total: number | null };
    expect(lines.returned).toBe(10);
    expect(result.data!.truncated).toBe(false);
  });
});

describe('通用安全断言（模板生成，不经模型）', () => {
  it('必须导出命名约定的对象', async () => {
    const mod = (await import('../src/tools/builtin/fs-read.tool.js')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    expect(exported, 'src/tools/builtin/fs-read.tool.ts 必须导出一个工具定义').toBeTruthy();
    const def = exported as { name?: string; wireName?: string; inputSchema?: unknown };
    expect(typeof def.name).toBe('string');
    expect(typeof def.wireName).toBe('string');
  });

  it('必须注册进 BUILTIN_TOOLS（否则产品里调不到）', async () => {
    const mod = (await import('../src/tools/builtin/fs-read.tool.js')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    const def = exported as { name?: string };
    const registry = (await import('../src/tools/builtin/index.js')) as unknown as { BUILTIN_TOOLS?: { name?: string }[] };
    const names = (registry.BUILTIN_TOOLS ?? []).map((t) => t.name);
    expect(names, 'fs-read.tool 没有注册进 BUILTIN_TOOLS').toContain(def.name);
  });

  it('非法输入必须被拒绝，且不得越出沙箱', async () => {
    const mod = (await import('../src/tools/builtin/fs-read.tool.js')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    const def = exported as { handler?: (a: Record<string, unknown>, c: unknown) => Promise<{ ok: boolean }> };
    expect(typeof def.handler).toBe('function');
    const ctx = {
      sessionId: 's', toolCallId: 't', callId: 'c', iteration: 1,
      sandboxRoot: process.cwd(), signal: new AbortController().signal, reportProgress: () => {},
    };
    for (const bad of ['../package.json', 'C:/Windows/win.ini', '/etc/passwd', '']) {
      const out = await def.handler!({ path: bad, file: bad }, ctx);
      expect(out.ok, "越界输入 " + bad + " 不该被接受").toBe(false);
    }
  });
});
