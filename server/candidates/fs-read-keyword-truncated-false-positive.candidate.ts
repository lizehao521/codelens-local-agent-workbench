import { describe, expect, it } from 'vitest';
import { fsReadTool } from '../src/tools/builtin/fs-read.tool.js';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';

const ctx = {
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: process.cwd(),
  signal: new AbortController().signal,
  reportProgress: () => {},
};

const relPath = 'tmp/fs-read-keyword-truncated-false-positive.txt';

describe('fs.read keyword-only truncated flag false positive', () => {
  it('keyword-only partial match returns truncated=false', async () => {
    mkdirSync('tmp', { recursive: true });
    writeFileSync(relPath, 'alpha\nbeta\nalpha\ngamma\nalpha\n', 'utf8');
    const r = await fsReadTool.handler!({ path: relPath, keyword: 'alpha' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.data?.truncated).toBe(false);
    rmSync(relPath, { force: true });
  });

  it('keyword-only zero match returns truncated=false', async () => {
    mkdirSync('tmp', { recursive: true });
    writeFileSync(relPath, 'alpha\nbeta\ngamma\n', 'utf8');
    const r = await fsReadTool.handler!({ path: relPath, keyword: 'delta' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.data?.truncated).toBe(false);
    rmSync(relPath, { force: true });
  });

  it('keyword-only partial match with large maxBytes returns truncated=false', async () => {
    mkdirSync('tmp', { recursive: true });
    writeFileSync(relPath, 'alpha\nbeta\nalpha\ngamma\nalpha\n', 'utf8');
    const r = await fsReadTool.handler!({ path: relPath, keyword: 'alpha', maxBytes: 1048576 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.data?.truncated).toBe(false);
    rmSync(relPath, { force: true });
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
