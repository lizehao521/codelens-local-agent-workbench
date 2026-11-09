/**
 * fs.write / fs.read / fs.list 行为断言（真实 handler 调用）。
 *
 * 覆盖:
 *  - create 创建文件 → 断言 ok/data.path/data.operation/data.sizeBytes
 *  - read 回读 → 断言 ok/data.kind/data.content/data.sizeBytes
 *  - list 列目录 → 断言 ok/data.entries 命中刚创建的文件清单
 *  - overwrite 覆盖 → 断言 operation 与覆盖后的字节数，再 read 验证内容
 *  - read 不存在文件 → 断言 ok=false / error.code=TOOL_NOT_FOUND / error.kind=not_found
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsWriteTool } from '../src/tools/builtin/fs-write.tool.js';
import { fsReadTool } from '../src/tools/builtin/fs-read.tool.js';
import { fsListTool } from '../src/tools/builtin/fs-list.tool.js';
import type { ToolExecutionContext } from '../src/types/tool.js';

let sandbox: string;
let ctx: ToolExecutionContext;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'fs-behavior-'));
  ctx = {
    sessionId: 's',
    toolCallId: 't',
    callId: 'c',
    iteration: 1,
    sandboxRoot: sandbox,
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
});

afterEach(() => {
  // 清理 best-effort：残留目录由环境侧回收，不应把用例判红。
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
  }
});

describe('fs.write / fs.read / fs.list 行为', () => {
  it('create → read → list → overwrite 全链路，并断言读取不存在文件的报错路径', async () => {
    const initial = 'line1\nline2';
    const replacement = 'overwritten';

    // 1) create
    const created = await fsWriteTool.handler(
      { path: 'alpha.txt', operation: 'create', content: initial },
      ctx,
    );
    expect(created.ok).toBe(true);
    expect(created.data?.path).toBe('alpha.txt');
    expect(created.data?.operation).toBe('create');
    expect(created.data?.sizeBytes).toBe(Buffer.byteLength(initial, 'utf8'));

    // 2) read 回读创建的内容
    const readBack = await fsReadTool.handler({ path: 'alpha.txt' }, ctx);
    expect(readBack.ok).toBe(true);
    expect(readBack.data?.kind).toBe('file');
    expect(readBack.data?.content).toBe(initial);
    expect(readBack.data?.sizeBytes).toBe(Buffer.byteLength(initial, 'utf8'));

    // 3) list 列出目录，应命中 alpha.txt 及其字节数
    const listed = await fsListTool.handler({ path: '.' }, ctx);
    expect(listed.ok).toBe(true);
    expect(listed.data?.kind).toBe('directory');
    const entry = (listed.data?.entries as Array<{ name: string; type: string; sizeBytes: number | null }>).find(
      (e) => e.name === 'alpha.txt',
    );
    expect(entry).toBeDefined();
    expect(entry?.type).toBe('file');
    expect(entry?.sizeBytes).toBe(Buffer.byteLength(initial, 'utf8'));

    // 4) overwrite 覆盖，再 read 验证内容已替换
    const overwritten = await fsWriteTool.handler(
      { path: 'alpha.txt', operation: 'overwrite', content: replacement },
      ctx,
    );
    expect(overwritten.ok).toBe(true);
    expect(overwritten.data?.operation).toBe('overwrite');
    expect(overwritten.data?.sizeBytes).toBe(Buffer.byteLength(replacement, 'utf8'));

    const readAfterOverwrite = await fsReadTool.handler({ path: 'alpha.txt' }, ctx);
    expect(readAfterOverwrite.ok).toBe(true);
    expect(readAfterOverwrite.data?.content).toBe(replacement);

    // 5) 读取不存在文件 → 报错路径
    const missing = await fsReadTool.handler({ path: 'missing.txt' }, ctx);
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe('TOOL_NOT_FOUND');
    expect(missing.error?.kind).toBe('not_found');
    expect(missing.error?.message).toContain('沙箱内不存在 missing.txt');
  });
});