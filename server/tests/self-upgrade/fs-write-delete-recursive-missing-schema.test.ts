import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { fsWriteTool } from '../../src/tools/builtin/fs-write.tool.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 每条用例一个独立临时沙箱，**不共用 process.cwd()**。
 *
 * 为什么必须这样：全量回归时 vitest 多 worker 并发跑，判据在 server 根创建
 * test-delete-* 目录会与其它用例互踩 —— 实测单独跑 6/6 绿、全量跑 4 条红，
 * 而围栏只看全量结果，于是把一次正确的修复判成「真回归」。
 */
let sandbox = '';

const makeCtx = () => ({
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: sandbox,
  signal: new AbortController().signal,
  reportProgress: () => {},
});

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'fs-del-'));
});

afterEach(async () => {
  // 判据自己造的临时目录必须自己清：残留会让下一次跑变成「目录已存在」，
  // 也会污染其它用例（实测踩过：探针残留导致同一份探针第二次必失败）。
  await rm(sandbox, { recursive: true, force: true });
});

describe('fsWriteTool delete operation recursive parameter defect', () => {
  it('should delete directory when recursive=true is provided', async () => {
    const dirPath = join(sandbox, 'test-delete-recursive-true');
    await mkdir(dirPath, { recursive: true });
    await writeFile(join(dirPath, 'nested.txt'), 'content');

    const result = await fsWriteTool.handler!({
      path: 'test-delete-recursive-true',
      operation: 'delete',
      recursive: true,
    }, makeCtx());

    expect(result.ok).toBe(true);
    // 断言**行为**，不断言 summary 文案：summary 是给人看的描述，中英文随实现变化。
    // 钉死文案会把合法实现判成错（实测：判据要 'deleted'、实现写「已删除」，
    // Agent 只好把中文摘要改成英文来迎合判据 —— 这是判据在带坏实现）。
    expect(existsSync(dirPath)).toBe(false);
  });

  it('should reject directory deletion when recursive=false', async () => {
    const dirPath = join(sandbox, 'test-delete-recursive-false');
    await mkdir(dirPath, { recursive: true });

    const result = await fsWriteTool.handler!({
      path: 'test-delete-recursive-false',
      operation: 'delete',
      recursive: false,
    }, makeCtx());

    expect(result.ok).toBe(false);
    // kind 只能取 ToolErrorKind 的 10 个锁定值。precondition_failed 不在枚举里 ——
    // 判据写它会逼实现引入非法 kind，tsc 直接 TS2322，整次升级必挂。
    expect(result.error?.kind).toBe('invalid_args');
    expect(existsSync(dirPath)).toBe(true);
  });

  it('should delete file when recursive=true is provided', async () => {
    const filePath = join(sandbox, 'test-delete-file-recursive');
    await writeFile(filePath, 'content');

    const result = await fsWriteTool.handler!({
      path: 'test-delete-file-recursive',
      operation: 'delete',
      recursive: true,
    }, makeCtx());

    expect(result.ok).toBe(true);
    expect(existsSync(filePath)).toBe(false);
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
    for (const bad of ['../package.json', 'C:/Windows/win.ini', '/etc/passwd', '']) {
      const out = await def.handler!({ path: bad, file: bad }, makeCtx());
      expect(out.ok, '越界输入 ' + bad + ' 不该被接受').toBe(false);
    }
  });
});
