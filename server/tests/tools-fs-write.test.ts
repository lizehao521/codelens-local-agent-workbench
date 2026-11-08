/**
 * tests/tools-fs-write.test.ts
 *
 * 覆盖两个内置工具：
 *  - fs.write   ：在 os.tmpdir() 下验证 create / overwrite 的真实落盘效果；
 *  - json.format：断言 pretty / compact / sort-keys / validate 的处理结果。
 *
 * 说明：fs.write 走沙箱路径校验（path-jail）。若运行环境把 os.tmpdir() 判为沙箱外，
 * 测试会退回到 cwd 下的临时目录继续验证 create/overwrite，并输出诊断信息，
 * 避免把「环境限制」误报成「工具缺陷」。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as fsWriteModule from '../src/tools/builtin/fs-write.tool.js';
import { jsonFormatTool } from '../src/tools/builtin/json-format.tool.js';

type AnyTool = {
  name: string;
  wireName?: string;
  execute: (input: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;
};

/** 从模块导出里按工具 name 取 ToolDefinition（不依赖具体导出标识符）。 */
function pickTool(mod: Record<string, unknown>, name: string): AnyTool {
  for (const value of Object.values(mod)) {
    if (
      value &&
      typeof value === 'object' &&
      (value as AnyTool).name === name &&
      typeof (value as AnyTool).execute === 'function'
    ) {
      return value as AnyTool;
    }
  }
  throw new Error(`未在模块导出中找到工具定义：${name}`);
}

const fsWriteTool = pickTool(fsWriteModule as unknown as Record<string, unknown>, 'fs.write');

/** 统一调用入口：多传一个 ctx 对只接收 input 的实现无副作用。 */
async function run(tool: AnyTool, input: Record<string, unknown>): Promise<any> {
  return (await tool.execute(input, { cwd: process.cwd() })) as any;
}

/** 从 outcome 里尽力取出「文本结果」，兼容 data/result/output 等常见承载字段。 */
function extractText(outcome: any): string {
  const candidates = [outcome?.data, outcome?.result, outcome?.output, outcome?.summary];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate;
    if (candidate && typeof candidate === 'object') {
      for (const key of ['output', 'text', 'result', 'value', 'formatted', 'json']) {
        const inner = (candidate as Record<string, unknown>)[key];
        if (typeof inner === 'string') return inner;
      }
    }
  }
  return JSON.stringify(outcome);
}

function isSecurityDenial(outcome: any): boolean {
  return outcome?.ok === false && outcome?.error?.kind === 'security';
}

/** 依次尝试 os.tmpdir() 与 cwd 下的临时目录，返回第一个可写的工作目录。 */
async function makeWorkDir(t: test.TestContext): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codelens-fs-write-'));
  const probe = path.join(tmpDir, '.probe');
  const probeOutcome = await run(fsWriteTool, { path: probe, operation: 'create', content: 'probe' });
  if (probeOutcome?.ok === true) {
    return { dir: tmpDir, cleanup: () => rm(tmpDir, { recursive: true, force: true }) };
  }
  await rm(tmpDir, { recursive: true, force: true });
  if (!isSecurityDenial(probeOutcome)) {
    assert.fail(`fs.write 在 os.tmpdir() 下探测失败：${JSON.stringify(probeOutcome)}`);
  }
  t.diagnostic('os.tmpdir() 被沙箱拒绝，退回 cwd 下的临时目录继续验证');
  const localDir = await mkdtemp(path.join(process.cwd(), '.tmp-fs-write-'));
  return { dir: localDir, cleanup: () => rm(localDir, { recursive: true, force: true }) };
}

test('fs.write：在 os.tmpdir() 下 create 会真实创建文件', async (t) => {
  const { dir, cleanup } = await makeWorkDir(t);
  const target = path.join(dir, 'note.txt');
  try {
    const outcome = await run(fsWriteTool, { path: target, operation: 'create', content: 'first line' });
    assert.equal(outcome?.ok, true, `create 应成功，实际：${JSON.stringify(outcome)}`);
    assert.equal(await readFile(target, 'utf8'), 'first line');
  } finally {
    await cleanup();
  }
});

test('fs.write：overwrite 会替换已有内容', async (t) => {
  const { dir, cleanup } = await makeWorkDir(t);
  const target = path.join(dir, 'note.txt');
  try {
    const created = await run(fsWriteTool, { path: target, operation: 'create', content: 'old content' });
    assert.equal(created?.ok, true, `create 应成功，实际：${JSON.stringify(created)}`);

    const overwritten = await run(fsWriteTool, { path: target, operation: 'overwrite', content: 'new content' });
    assert.equal(overwritten?.ok, true, `overwrite 应成功，实际：${JSON.stringify(overwritten)}`);
    assert.equal(await readFile(target, 'utf8'), 'new content');
  } finally {
    await cleanup();
  }
});

test('json.format：pretty 输出两空格缩进结果', async () => {
  const input = '{"b":2,"a":[1,{"c":3}]}';
  const outcome = await run(jsonFormatTool as unknown as AnyTool, { input, mode: 'pretty' });
  assert.equal(outcome?.ok, true, `pretty 应成功，实际：${JSON.stringify(outcome)}`);

  const expected = JSON.stringify({ b: 2, a: [1, { c: 3 }] }, null, 2);
  const text = extractText(outcome);
  assert.ok(text.includes(expected), `pretty 结果应包含缩进后的 JSON，实际：${text}`);
});

test('json.format：compact 去掉空白，sort-keys 按键排序', async () => {
  const input = '{ "b" : 2 , "a" : 1 }';

  const compact = await run(jsonFormatTool as unknown as AnyTool, { input, mode: 'compact' });
  assert.equal(compact?.ok, true, `compact 应成功，实际：${JSON.stringify(compact)}`);
  const compactText = extractText(compact);
  assert.ok(compactText.includes('{"b":2,"a":1}'), `compact 结果应无空白，实际：${compactText}`);

  const sorted = await run(jsonFormatTool as unknown as AnyTool, { input, mode: 'sort-keys' });
  assert.equal(sorted?.ok, true, `sort-keys 应成功，实际：${JSON.stringify(sorted)}`);
  const sortedText = extractText(sorted);
  assert.ok(sortedText.indexOf('"a"') < sortedText.indexOf('"b"'), `sort-keys 应把 a 排在 b 前，实际：${sortedText}`);
});

test('json.format：validate 对非法 JSON 返回失败', async () => {
  const outcome = await run(jsonFormatTool as unknown as AnyTool, { input: '{"a":', mode: 'validate' });
  assert.equal(outcome?.ok, false, `非法 JSON 应失败，实际：${JSON.stringify(outcome)}`);
});
