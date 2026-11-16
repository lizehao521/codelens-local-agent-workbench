import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fsWriteTool } from '../../src/tools/builtin/fs-write.tool.js';

let root = '';
const ctx = () => ({
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: root,
  signal: new AbortController().signal,
  reportProgress: () => {},
});

async function call(args: Record<string, unknown>) {
  return fsWriteTool.handler!(args, ctx());
}

describe('fs.write 错误下一步建议', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'fs-write-next-'));
    await writeFile(path.join(root, 'exists.txt'), 'alpha\nbeta\n', 'utf8');
    await writeFile(path.join(root, 'ambiguous.txt'), 'same same', 'utf8');
    await writeFile(path.join(root, 'rename.txt'), 'rename me', 'utf8');
    await mkdir(path.join(root, 'dir'), { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('operation 非法时给出可选操作', async () => {
    const r = await call({ path: 'exists.txt', operation: 'bad' });
    expect(r.ok).toBe(false);
    expect(r.error?.suggestion).toContain('create');
    expect(r.error?.suggestion).toContain('overwrite');
  });

  it('create 遇到已存在文件时指向 overwrite', async () => {
    const r = await call({ path: 'exists.txt', operation: 'create', content: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error?.suggestion).toContain('overwrite');
  });

  it('replace 未命中时指向先 fs.read', async () => {
    const r = await call({ path: 'exists.txt', operation: 'replace', oldText: 'not-there', newText: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error?.suggestion).toContain('fs.read');
  });

  it('replace 多处命中时要求增加上下文', async () => {
    const r = await call({ path: 'ambiguous.txt', operation: 'replace', oldText: 'same', newText: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error?.suggestion).toContain('上下文');
  });

  it('删除目录缺少 recursive 时给出参数名', async () => {
    const r = await call({ path: 'dir', operation: 'delete' });
    expect(r.ok).toBe(false);
    expect(r.error?.suggestion).toContain('recursive: true');
  });

  it('rename 缺少 newPath 时给出下一步', async () => {
    const r = await call({ path: 'rename.txt', operation: 'rename' });
    expect(r.ok).toBe(false);
    expect(r.error?.suggestion).toContain('newPath');
  });

  it('oldText 为空时指向复制真实原文', async () => {
    const r = await call({ path: 'exists.txt', operation: 'replace', oldText: '', newText: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error?.suggestion).toContain('非空');
  });
});
