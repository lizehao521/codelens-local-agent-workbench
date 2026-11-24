import { describe, expect, it } from 'vitest';
import { fsListTool } from '../src/tools/builtin/fs-list.tool.js';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

const ctx = {
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: process.cwd(),
  signal: new AbortController().signal,
  reportProgress: () => {},
};

const OUTSIDE_FILE = resolve(process.cwd(), '..', 'fs-list-symlink-outside.txt');
const LINK_NAME = 'fs-list-symlink-link.txt';
const LINK_PATH = join(process.cwd(), LINK_NAME);

describe('fs.list recursive symlink metadata leakage', () => {
  it('递归遍历时软链条目不应暴露沙箱外目标文件的 sizeBytes', async () => {
    await fs.writeFile(OUTSIDE_FILE, 'sensitive-outside-content');
    await fs.symlink(OUTSIDE_FILE, LINK_PATH);
    try {
      const r = await fsListTool.handler!({ path: '.', recursive: true }, ctx);
      expect(r.ok).toBe(true);
      const raw = r.data as { entries?: unknown } | undefined;
      const entries = Array.isArray(raw?.entries) ? raw.entries : [];
      const link = entries.find((e: unknown) => (e as { name?: string })?.name === LINK_NAME);
      expect(link).toBeDefined();
      expect((link as { sizeBytes?: number | null } | undefined)?.sizeBytes).toBeNull();
    } finally {
      await fs.unlink(LINK_PATH).catch(() => {});
      await fs.unlink(OUTSIDE_FILE).catch(() => {});
    }
  });

  it('递归遍历时软链条目的 type 不应为 file', async () => {
    await fs.writeFile(OUTSIDE_FILE, 'sensitive-outside-content');
    await fs.symlink(OUTSIDE_FILE, LINK_PATH);
    try {
      const r = await fsListTool.handler!({ path: '.', recursive: true }, ctx);
      expect(r.ok).toBe(true);
      const raw = r.data as { entries?: unknown } | undefined;
      const entries = Array.isArray(raw?.entries) ? raw.entries : [];
      const link = entries.find((e: unknown) => (e as { name?: string })?.name === LINK_NAME);
      expect(link).toBeDefined();
      expect((link as { type?: string } | undefined)?.type).not.toBe('file');
    } finally {
      await fs.unlink(LINK_PATH).catch(() => {});
      await fs.unlink(OUTSIDE_FILE).catch(() => {});
    }
  });

  it('递归遍历时软链指向目录不应泄露沙箱外目录内子条目', async () => {
    const outsideDir = resolve(process.cwd(), '..', 'fs-list-symlink-outside-dir');
    const outsideChild = join(outsideDir, 'child.txt');
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(outsideChild, 'outside-child');
    const linkDir = join(process.cwd(), 'fs-list-symlink-dir-link');
    await fs.symlink(outsideDir, linkDir);
    try {
      const r = await fsListTool.handler!({ path: '.', recursive: true }, ctx);
      if (!r.ok) {
        expect(['security', 'not_found', 'internal']).toContain(r.error?.kind);
        return;
      }
      expect(r.ok).toBe(true);
      const raw = r.data as { entries?: unknown } | undefined;
      const entries = Array.isArray(raw?.entries) ? raw.entries : [];
      const names = entries.map((e: unknown) => (e as { name?: string })?.name).filter(Boolean) as string[];
      expect(names).not.toContain('child.txt');
      const dirLink = entries.find((e: unknown) => (e as { name?: string })?.name === 'fs-list-symlink-dir-link');
      expect((dirLink as { sizeBytes?: number | null } | undefined)?.sizeBytes).toBeNull();
    } finally {
      await fs.unlink(linkDir).catch(() => {});
      await fs.unlink(outsideChild).catch(() => {});
      await fs.rmdir(outsideDir).catch(() => {});
    }
  });
});

describe('通用安全断言（模板生成，不经模型）', () => {
  it('必须导出命名约定的对象', async () => {
    const mod = (await import('../src/tools/builtin/fs-list.tool.js')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    expect(exported, 'src/tools/builtin/fs-list.tool.ts 必须导出一个工具定义').toBeTruthy();
    const def = exported as { name?: string; wireName?: string; inputSchema?: unknown };
    expect(typeof def.name).toBe('string');
    expect(typeof def.wireName).toBe('string');
  });

  it('必须注册进 BUILTIN_TOOLS（否则产品里调不到）', async () => {
    const mod = (await import('../src/tools/builtin/fs-list.tool.js')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    const def = exported as { name?: string };
    const registry = (await import('../src/tools/builtin/index.js')) as unknown as { BUILTIN_TOOLS?: { name?: string }[] };
    const names = (registry.BUILTIN_TOOLS ?? []).map((t) => t.name);
    expect(names, 'fs-list.tool 没有注册进 BUILTIN_TOOLS').toContain(def.name);
  });

  it('非法输入必须被拒绝，且不得越出沙箱', async () => {
    const mod = (await import('../src/tools/builtin/fs-list.tool.js')) as Record<string, unknown>;
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
