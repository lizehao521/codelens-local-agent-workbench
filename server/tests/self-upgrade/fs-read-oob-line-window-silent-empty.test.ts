import { describe, expect, it } from 'vitest';
import { fsReadTool } from '../../src/tools/builtin/fs-read.tool.js';
import { writeFileSync, unlinkSync } from 'node:fs';

const FILE_NAME = 'probe-fs-read-oob-line-window.txt';
const FILE_CONTENT = 'line1\nline2\nline3\nline4\nline5\n';

const ctx = {
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: process.cwd(),
  signal: new AbortController().signal,
  reportProgress: () => {},
};

describe('fs.read 越界行窗口静默返回空内容', () => {
  it('lineStart 超过总行数时不应静默返回 ok=true 且未标记 truncated', async () => {
    writeFileSync(FILE_NAME, FILE_CONTENT, 'utf8');
    try {
      const result = await fsReadTool.handler!({ path: FILE_NAME, lineStart: 10, lineEnd: 20 }, ctx);
      expect(result.ok === true && result.data?.truncated !== true).toBe(false);
    } finally {
      try { unlinkSync(FILE_NAME); } catch {}
    }
  });

  it('越界行窗口返回错误时 error.kind 必须是 invalid_args 或 internal', async () => {
    writeFileSync(FILE_NAME, FILE_CONTENT, 'utf8');
    try {
      const result = await fsReadTool.handler!({ path: FILE_NAME, lineStart: 10, lineEnd: 20 }, ctx);
      if (!result.ok && result.error) {
        expect(['invalid_args', 'internal']).toContain(result.error.kind);
      } else {
        expect(result.ok === true && result.data?.truncated !== true).toBe(false);
      }
    } finally {
      try { unlinkSync(FILE_NAME); } catch {}
    }
  });

  it('越界行窗口若未报错，data.truncated 必须为 true', async () => {
    writeFileSync(FILE_NAME, FILE_CONTENT, 'utf8');
    try {
      const result = await fsReadTool.handler!({ path: FILE_NAME, lineStart: 10, lineEnd: 20 }, ctx);
      if (result.ok) {
        expect(result.data?.truncated).toBe(true);
      } else {
        expect(result.error).toBeDefined();
      }
    } finally {
      try { unlinkSync(FILE_NAME); } catch {}
    }
  });
});

describe('通用安全断言（模板生成，不经模型）', () => {
  it('必须导出命名约定的对象', async () => {
    const mod = (await import('../../src/tools/builtin/fs-read.tool.js')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    expect(exported, 'src/tools/builtin/fs-read.tool.ts 必须导出一个工具定义').toBeTruthy();
    const def = exported as { name?: string; wireName?: string; inputSchema?: unknown };
    expect(typeof def.name).toBe('string');
    expect(typeof def.wireName).toBe('string');
  });

  it('必须注册进 BUILTIN_TOOLS（否则产品里调不到）', async () => {
    const mod = (await import('../../src/tools/builtin/fs-read.tool.js')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    const def = exported as { name?: string };
    const registry = (await import('../../src/tools/builtin/index.js')) as unknown as { BUILTIN_TOOLS?: { name?: string }[] };
    const names = (registry.BUILTIN_TOOLS ?? []).map((t) => t.name);
    expect(names, 'fs-read.tool 没有注册进 BUILTIN_TOOLS').toContain(def.name);
  });

  it('非法输入必须被拒绝，且不得越出沙箱', async () => {
    const mod = (await import('../../src/tools/builtin/fs-read.tool.js')) as Record<string, unknown>;
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
