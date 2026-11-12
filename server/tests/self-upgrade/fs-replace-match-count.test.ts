import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fsWriteTool } from '../../src/tools/builtin/fs-write.tool.js';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ctx = {
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: process.cwd(),
  signal: new AbortController().signal,
  reportProgress: () => {}
};

let testDir: string;

describe('fsWriteTool replace operation match count defect', () => {
  beforeAll(async () => {
    testDir = await mkdtemp(join(process.cwd(), 'fs-write-test-'));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should succeed when oldText appears exactly once', async () => {
    const filePath = join(testDir, 'unique.txt');
    await writeFile(filePath, 'line1\nline2\nline3', 'utf-8');
    const relPath = relative(process.cwd(), filePath);

    const result = await fsWriteTool.handler!({
      path: relPath,
      operation: 'replace',
      oldText: 'line2',
      newText: 'LINE2'
    }, ctx);

    expect(result.ok).toBe(true);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('line1\nLINE2\nline3');
  });

  it('should fail with location info when oldText appears multiple times', async () => {
    const filePath = join(testDir, 'multi.txt');
    await writeFile(filePath, 'target\nmiddle\ntarget\n', 'utf-8');
    const relPath = relative(process.cwd(), filePath);

    const result = await fsWriteTool.handler!({
      path: relPath,
      operation: 'replace',
      oldText: 'target',
      newText: 'REPLACED'
    }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(['invalid_args', 'internal']).toContain(result.error!.kind);
    expect(result.error!.message).toMatch(/line\s*\d+/i);
    expect(result.error!.message).toMatch(/col\s*\d+/i);
  });

  it('should fail when oldText appears zero times', async () => {
    const filePath = join(testDir, 'nomatch.txt');
    await writeFile(filePath, 'nothing here', 'utf-8');
    const relPath = relative(process.cwd(), filePath);

    const result = await fsWriteTool.handler!({
      path: relPath,
      operation: 'replace',
      oldText: 'missing',
      newText: 'REPLACED'
    }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(['invalid_args', 'internal']).toContain(result.error!.kind);
  });
});

describe('通用安全断言（模板生成，不经模型）', () => {
  it('必须导出命名约定的对象', async () => {
    const mod = (await import('../../src/tools/builtin/fs-write.tool.js')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    expect(exported, 'src/tools/builtin/fs-write.tool.ts 必须导出一个工具定义').toBeTruthy();
    const def = exported as { name?: string; wireName?: string; inputSchema?: unknown };
    expect(typeof def.name).toBe('string');
    expect(typeof def.wireName).toBe('string');
  });

  it('必须注册进 BUILTIN_TOOLS（否则产品里调不到）', async () => {
    const mod = (await import('../../src/tools/builtin/fs-write.tool.js')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    const def = exported as { name?: string };
    const registry = (await import('../../src/tools/builtin/index.js')) as unknown as { BUILTIN_TOOLS?: { name?: string }[] };
    const names = (registry.BUILTIN_TOOLS ?? []).map((t) => t.name);
    expect(names, 'fs-write.tool 没有注册进 BUILTIN_TOOLS').toContain(def.name);
  });

  it('非法输入必须被拒绝，且不得越出沙箱', async () => {
    const mod = (await import('../../src/tools/builtin/fs-write.tool.js')) as Record<string, unknown>;
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
