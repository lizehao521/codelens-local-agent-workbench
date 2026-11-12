/**
 * fs.read 的默认读取上限：**文档与实现必须说同一件事**。
 *
 * 这题的教训值一份判据：常量 16 KiB 是刻意降下来的（磁盘读放大 / tool_results
 * 归档体积 / SSE 全量推送会卡渲染，理由写在文件头注释里），只有 schema 描述
 * 忘了跟着改，还写着 262144。于是它被提成「实现错、文档对」的缺陷，
 * 一轮派单把常量改回 256 KiB，还顺手删掉了那几行理由。
 *
 * 真正的错法是反的：**过期的是描述**。这里把两者钉在一起，
 * 以后谁再单独动一边，都会在这里红。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fsReadTool } from '../src/tools/builtin/fs-read.tool.js';

const IMPL_DEFAULT = 16384;

let dir = '';

const ctx = () => ({
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: process.cwd(),
  signal: new AbortController().signal,
  reportProgress: () => {},
});

describe('fs.read maxBytes 默认值：描述与实现一致', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(process.cwd(), 'fs-read-default-'));
    await writeFile(join(dir, 'big.txt'), 'x'.repeat(20000), 'utf8');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('schema 描述里的默认值与实现常量一致（缺省 16384）', () => {
    const props = (fsReadTool.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
    const desc = String(props.maxBytes?.description ?? '');
    expect(desc, 'maxBytes 描述里必须写明真实默认值 16384').toContain(String(IMPL_DEFAULT));
    expect(desc, 'maxBytes 描述里不该再出现过期的 262144').not.toContain('262144');
  });

  it('工具总描述里也不许再写 256KB', () => {
    expect(String(fsReadTool.description ?? '')).not.toContain('256KB');
  });

  it('不传 maxBytes 读 20KB 文件：按 16384 截断，且明确标记 truncated', async () => {
    const r = await fsReadTool.handler!({ path: relative(process.cwd(), join(dir, 'big.txt')) }, ctx());
    expect(r.ok).toBe(true);
    const data = r.data as { content?: string; truncated?: boolean };
    expect(data.truncated).toBe(true);
    expect((data.content ?? '').length).toBeLessThanOrEqual(IMPL_DEFAULT + 200); // 允许附带截断提示
  });

  it('显式传 maxBytes 时以调用方为准（文档说的"上限"是真上限）', async () => {
    const r = await fsReadTool.handler!(
      { path: relative(process.cwd(), join(dir, 'big.txt')), maxBytes: 262144 },
      ctx(),
    );
    expect(r.ok).toBe(true);
    const data = r.data as { content?: string; truncated?: boolean };
    expect(data.truncated).toBe(false);
    expect((data.content ?? '').length).toBe(20000);
  });
});
