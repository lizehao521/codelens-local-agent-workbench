import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fsWriteTool } from '../../src/tools/builtin/fs-write.tool.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const testRoot = path.join(os.tmpdir(), `fs-write-delete-test-${Date.now()}`);
const ctx = {
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: testRoot,
  signal: new AbortController().signal,
  reportProgress: () => {},
};

describe('fsWriteTool delete directory recursive validation', () => {
  beforeAll(async () => {
    await fs.mkdir(testRoot, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  it('returns invalid_args when deleting non-empty directory without recursive', async () => {
    const dirRel = 'target-dir';
    await fs.mkdir(path.join(testRoot, dirRel));
    await fs.writeFile(path.join(testRoot, dirRel, 'file.txt'), 'content');

    const result = await fsWriteTool.handler!({ path: dirRel, operation: 'delete' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('invalid_args');
    expect(result.error?.message).toContain('recursive');
  });

  it('deletes file successfully without recursive', async () => {
    const fileRel = 'target-file.txt';
    await fs.writeFile(path.join(testRoot, fileRel), 'content');

    const result = await fsWriteTool.handler!({ path: fileRel, operation: 'delete' }, ctx);

    expect(result.ok).toBe(true);
    await expect(fs.stat(path.join(testRoot, fileRel))).rejects.toThrow();
  });

  it('deletes directory successfully with recursive=true', async () => {
    const dirRel = 'target-dir-recursive';
    await fs.mkdir(path.join(testRoot, dirRel), { recursive: true });
    await fs.writeFile(path.join(testRoot, dirRel, 'file.txt'), 'content');

    const result = await fsWriteTool.handler!({ path: dirRel, operation: 'delete', recursive: true }, ctx);

    expect(result.ok).toBe(true);
    await expect(fs.stat(path.join(testRoot, dirRel))).rejects.toThrow();
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
