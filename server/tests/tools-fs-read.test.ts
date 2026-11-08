/**
 * tests/tools-fs-read.test.ts
 *
 * 覆盖 fs.read 与 fs.list 两个内置工具的真实行为：
 *  - 在 os.tmpdir() 下建临时沙箱目录，真实落盘再读
 *  - fs.read：整文件读取、行窗口、keyword 过滤、base64、不存在路径报错
 *  - fs.list：非递归/递归列举、maxEntries 校验、不存在目录报错
 *
 * 只依赖 node:test / node:assert，不引入任何测试框架。
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { fsReadTool } from '../src/tools/builtin/fs-read.tool.js';
import { fsListTool } from '../src/tools/builtin/fs-list.tool.js';

/** 工具 handler 需要的上下文；测试里只关心 sandboxRoot / allowedDirs。 */
type ToolCtx = Parameters<typeof fsReadTool.handler>[1];

function makeCtx(sandboxRoot: string): ToolCtx {
  return { sandboxRoot, allowedDirs: [] } as unknown as ToolCtx;
}

/** 从 fs.read 的返回里取出正文（不同实现可能叫 content / text）。 */
function readContent(result: any): string {
  const data = result?.data ?? {};
  if (typeof data.content === 'string') return data.content;
  if (typeof data.text === 'string') return data.text;
  if (typeof result?.content === 'string') return result.content;
  return '';
}

/** 从 fs.list 的返回里取出条目数组，兼容 entries / items / children / 裸数组。 */
function listEntries(result: any): any[] {
  const data = result?.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.entries)) return data.entries;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.children)) return data.children;
  return [];
}

/** 条目名，兼容 name / path / basename 三种字段。 */
function entryName(entry: any): string {
  if (typeof entry === 'string') return path.basename(entry);
  const raw = entry?.name ?? entry?.path ?? entry?.basename ?? '';
  return path.basename(String(raw));
}

/** 断言“路径不存在”类错误：ok=false + 有 error 对象 + 文案提到不存在。 */
function assertNotFound(result: any, label: string) {
  assert.equal(result?.ok, false, `${label}：不存在路径应返回 ok=false`);
  assert.ok(result?.error, `${label}：应带 error 对象`);
  assert.equal(typeof result.error.code, 'string', `${label}：error.code 应为字符串`);
  const text = `${result.summary ?? ''} ${result.error.message ?? ''}`;
  assert.match(text, /不存在|not found|ENOENT/i, `${label}：错误文案应说明路径不存在，实际为「${text.trim()}」`);
}

const LINES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
const FILE_BODY = `${LINES.join('\n')}\n`;

describe('fs.read / fs.list', () => {
  let sandbox: string;

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'codelens-fs-tools-'));
    await writeFile(path.join(sandbox, 'sample.txt'), FILE_BODY, 'utf8');
    await writeFile(path.join(sandbox, 'notes.md'), '# notes\nkeyword-line\n', 'utf8');
    await mkdir(path.join(sandbox, 'sub'), { recursive: true });
    await writeFile(path.join(sandbox, 'sub', 'inner.txt'), 'inner\n', 'utf8');
  });

  after(async () => {
    if (sandbox) await rm(sandbox, { recursive: true, force: true });
  });

  describe('fs.read', () => {
    it('读取整个文件内容', async () => {
      const result: any = await fsReadTool.handler({ path: 'sample.txt' }, makeCtx(sandbox));
      assert.equal(result.ok, true, `读取失败：${result?.summary ?? ''}`);
      const content = readContent(result);
      assert.ok(content.includes('alpha'), '应包含首行 alpha');
      assert.ok(content.includes('epsilon'), '应包含末行 epsilon');
    });

    it('lineStart/lineEnd 只返回指定行窗口', async () => {
      const result: any = await fsReadTool.handler(
        { path: 'sample.txt', lineStart: 2, lineEnd: 3 },
        makeCtx(sandbox),
      );
      assert.equal(result.ok, true, `读取失败：${result?.summary ?? ''}`);
      const content = readContent(result);
      assert.ok(content.includes('beta'), '窗口应包含第 2 行 beta');
      assert.ok(content.includes('gamma'), '窗口应包含第 3 行 gamma');
      assert.ok(!content.includes('alpha'), '窗口不应包含第 1 行 alpha');
      assert.ok(!content.includes('delta'), '窗口不应包含第 4 行 delta');
    });

    it('keyword 只返回命中行', async () => {
      const result: any = await fsReadTool.handler(
        { path: 'notes.md', keyword: 'keyword-line' },
        makeCtx(sandbox),
      );
      assert.equal(result.ok, true, `读取失败：${result?.summary ?? ''}`);
      const content = readContent(result);
      assert.ok(content.includes('keyword-line'), '应包含命中行');
      assert.ok(!content.includes('# notes'), '不应包含未命中的标题行');
    });

    it('encoding=base64 返回可解码的 base64', async () => {
      const result: any = await fsReadTool.handler(
        { path: 'sample.txt', encoding: 'base64' },
        makeCtx(sandbox),
      );
      assert.equal(result.ok, true, `读取失败：${result?.summary ?? ''}`);
      const content = readContent(result).trim();
      assert.ok(content.length > 0, 'base64 结果不应为空');
      const decoded = Buffer.from(content, 'base64').toString('utf8');
      assert.ok(decoded.includes('alpha'), 'base64 解码后应还原原文');
    });

    it('读取不存在的文件返回 not_found 错误', async () => {
      const result: any = await fsReadTool.handler({ path: 'no-such-file.txt' }, makeCtx(sandbox));
      assertNotFound(result, 'fs.read');
    });
  });

  describe('fs.list', () => {
    it('非递归列出目录内容（名称/类型/大小）', async () => {
      const result: any = await fsListTool.handler({ path: '.' }, makeCtx(sandbox));
      assert.equal(result.ok, true, `列举失败：${result?.summary ?? ''}`);
      const names = listEntries(result).map(entryName);
      assert.ok(names.includes('sample.txt'), `应列出 sample.txt，实际：${names.join(',')}`);
      assert.ok(names.includes('notes.md'), `应列出 notes.md，实际：${names.join(',')}`);
      assert.ok(names.includes('sub'), `应列出子目录 sub，实际：${names.join(',')}`);
      assert.ok(!names.includes('inner.txt'), '非递归不应列出子目录内的文件');
    });

    it('recursive=true 递归列出子目录内容', async () => {
      const result: any = await fsListTool.handler({ path: '.', recursive: true }, makeCtx(sandbox));
      assert.equal(result.ok, true, `列举失败：${result?.summary ?? ''}`);
      const names = listEntries(result).map(entryName);
      assert.ok(names.includes('inner.txt'), `递归应列出 sub/inner.txt，实际：${names.join(',')}`);
    });

    it('maxEntries 截断返回条目数', async () => {
      const result: any = await fsListTool.handler({ path: '.', maxEntries: 1 }, makeCtx(sandbox));
      assert.equal(result.ok, true, `列举失败：${result?.summary ?? ''}`);
      assert.ok(listEntries(result).length <= 1, 'maxEntries=1 时最多返回 1 条');
    });

    it('maxEntries 越界返回 invalid_args 错误', async () => {
      const result: any = await fsListTool.handler({ path: '.', maxEntries: 0 }, makeCtx(sandbox));
      assert.equal(result.ok, false, 'maxEntries=0 应失败');
      assert.equal(result?.error?.code, 'TOOL_INVALID_ARGS');
    });

    it('列举不存在的目录返回 not_found 错误', async () => {
      const result: any = await fsListTool.handler({ path: 'no-such-dir' }, makeCtx(sandbox));
      assertNotFound(result, 'fs.list');
    });
  });
});
