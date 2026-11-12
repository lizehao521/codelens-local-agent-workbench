/**
 * code.check 列位置判据 —— 「只报行、不报列」的机械验收。
 *
 * 背景：`code.check` 上一轮上线后，`extractErrorInfo` 把 column 写死成 1。
 * 对 Agent 来说这等于「告诉你在第 93 行有错，但 240 行里你自己找」——
 * 上一轮它之所以反复凭空插入词，一部分原因就是反馈只到行，它得靠肉眼在整行里定位。
 *
 * 这里只锁**可观察行为**：给出「列号所指位置往右是什么」，而不是「列号等于几」，
 * 也不规定怎么算出列号（Node 的 stack 里带 caret 行，但那是实现路径，不是契约）。
 *
 * 判据全部以 `line` 仍准确为前提的回归项也在内：为了报列而把行搞错同样是缺陷。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolExecutionContext, ToolDefinition, ToolOutcome } from '../../src/types/tool.js';

let sandbox: string;
let ctx: ToolExecutionContext;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'codecol-'));
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
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // 宿主删除守卫偶发超时，清理是 best-effort。
  }
});

async function loadTool(): Promise<ToolDefinition> {
  const mod = (await import('../../src/tools/builtin/code-check.tool.js')) as Record<string, unknown>;
  const tool = mod.codeCheckTool as ToolDefinition | undefined;
  if (!tool) throw new Error('code-check.tool.ts 必须导出 codeCheckTool');
  return tool;
}

async function check(file: string, content: string): Promise<ToolOutcome> {
  writeFileSync(join(sandbox, file), content, 'utf8');
  const tool = await loadTool();
  return tool.handler({ path: file }, ctx);
}

function dataOf(outcome: ToolOutcome): Record<string, unknown> {
  return (outcome.data ?? {}) as Record<string, unknown>;
}

/** 取源码的某一行（1-based）；越界返回空串，避免判据自己抛错掩盖真实原因。 */
function lineOf(src: string, line: number): string {
  return src.split('\n')[line - 1] ?? '';
}

/**
 * 列号所指位置往右的一小段文本。
 * `column` 是 1-based；拿不到数字时返回 null，由各条判据自己决定如何判。
 */
function tailAt(outcome: ToolOutcome, src: string): { column: number | null; tail: string; line: number } {
  const d = dataOf(outcome);
  const column = typeof d.column === 'number' && Number.isFinite(d.column) ? d.column : null;
  const line = typeof d.line === 'number' ? d.line : 0;
  const text = lineOf(src, line);
  const tail = column === null ? '' : text.slice(Math.max(0, column - 1), Math.max(0, column - 1) + 16);
  return { column, tail, line };
}

describe('code.check —— 语法错误必须给出行内位置', () => {
  it('C1 行内偏后出错：列号指向出错 token，而不是行首', async () => {
    // V8 会报在 `bar`：`fooo` 被当成标识符，其后缺分号。
    const src = ['export const A = 1;', 'export const B = fooo bar baz;', ''].join('\n');
    const outcome = await check('a.ts', src);
    expect(outcome.ok, `本身应判失败：${outcome.summary}`).toBe(false);
    const { column, tail } = tailAt(outcome, src);
    expect(column, 'column 缺失或不是数字').not.toBeNull();
    expect(
      tail.startsWith('bar'),
      `列号 ${String(column)} 处往右是 ${JSON.stringify(tail)}，应指向 \`bar\`——恒为 1 等于让模型在整行里自救`,
    ).toBe(true);
  });

  it('C2 数字粘连：列号指向粘连段的尾部，而不是数字开头', async () => {
    // `1000oca` 里 V8 报在 `oca` 起点——这正是上一轮三次失败的同类笔误。
    const src = 'const a = 1; const b = 1000oca;\n';
    const outcome = await check('b.ts', src);
    expect(outcome.ok).toBe(false);
    const { column, tail } = tailAt(outcome, src);
    expect(column).not.toBeNull();
    expect(
      tail.startsWith('oca'),
      `列号 ${String(column)} 处往右是 ${JSON.stringify(tail)}，应指向 \`oca\``,
    ).toBe(true);
  });

  it('C3 括号未闭合：列号指向实际报错的那个字符', async () => {
    const src = ['const f = (a: number) => a * 2;', 'const g = f(1;', ''].join('\n');
    const outcome = await check('c.ts', src);
    expect(outcome.ok).toBe(false);
    const { column, tail } = tailAt(outcome, src);
    expect(column).not.toBeNull();
    expect(
      tail.startsWith(';'),
      `列号 ${String(column)} 处往右是 ${JSON.stringify(tail)}，应指向 \`;\``,
    ).toBe(true);
  });

  it('C4 多余词：列号指向那个多余的词', async () => {
    const src = ['const rawLines = [1];', 'if (rawLines.length === 0 scrubbed) {}', ''].join('\n');
    const outcome = await check('d.ts', src);
    expect(outcome.ok).toBe(false);
    const { column, tail } = tailAt(outcome, src);
    expect(column).not.toBeNull();
    expect(
      tail.startsWith('scrubbed'),
      `列号 ${String(column)} 处往右是 ${JSON.stringify(tail)}，应指向 \`scrubbed\``,
    ).toBe(true);
  });

  it('C5 回归：加了列号也不能把行号搞错', async () => {
    const src = ['const ok = 1;', 'const ok2 = 2;', 'const bad = f(1;', ''].join('\n');
    const outcome = await check('e.ts', src);
    expect(outcome.ok).toBe(false);
    expect(dataOf(outcome).line, '行号必须仍指向第 3 行').toBe(3);
  });

  it('C6 列号必须落在该行范围内，不能是编出来的数', async () => {
    const src = 'const a = 1; const b = 1000oca;\n';
    const outcome = await check('f.ts', src);
    const { column, line } = tailAt(outcome, src);
    const len = lineOf(src, line).length;
    expect(column, 'column 缺失或不是数字').not.toBeNull();
    expect(column!, '列号越界：不可能有一个不存在的列').toBeLessThanOrEqual(len + 1);
    expect(column!, '列号至少是 1').toBeGreaterThanOrEqual(1);
  });

  it('C7 回归：合法文件仍然通过，且不编造行号列号', async () => {
    const src = ['export interface Row {', '  id: number;', '}', '', 'export function pick<T extends Row>(rows: readonly T[]): T | null {', '  return rows[0] ?? null;', '}', ''].join('\n');
    const outcome = await check('ok.ts', src);
    expect(outcome.ok, `合法 TS 被判失败：${outcome.summary}`).toBe(true);
    const d = dataOf(outcome);
    expect(d.line ?? 0, '合法文件不该报出错行').toBe(0);
  });
});
