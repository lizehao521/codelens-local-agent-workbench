/**
 * fs.write `replace` 判据 —— 「改动粒度」缺失的机械验收。
 *
 * 背景（真实证据）：
 *   前两轮自我升级里，它每次都要**整份重写**目标文件（fs.write 只支持
 *   create/overwrite/append）。377 行的文件重写一次，就必然带上字面量噪声：
 *   1000oca、!data mammoth、=== 0 scrubbed —— 三次编译失败全来自「重抄一遍」。
 *   上一轮甚至为改一行 parseInt 的类型，重写了整份 106 行文件。
 *
 * 这里锁的是一个**精确局部修改**入口：给原文片段与替换片段，只动那一处。
 * 全部从 ToolOutcome 与磁盘结果观察，不规定实现。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolExecutionContext, ToolDefinition, ToolOutcome } from '../../src/types/tool.js';

let sandbox: string;
let ctx: ToolExecutionContext;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'fswrite-replace-'));
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
  // 本文件在 tests/self-upgrade/，回 src 要走两层。第一版写成 '../src/...'，
  // 于是 8 条判据全红在一个「模块找不到」上——红的理由和被测代码毫无关系。
  const { fsWriteTool } = await import('../../src/tools/builtin/fs-write.tool.js');
  return fsWriteTool;
}

async function replace(
  file: string,
  oldText: unknown,
  newText: unknown,
): Promise<ToolOutcome> {
  const tool = await loadTool();
  return tool.handler({ path: file, operation: 'replace', oldText, newText }, ctx);
}

function sha(file: string): string {
  return createHash('sha256').update(readFileSync(join(sandbox, file))).digest('hex');
}

/** 300 行夹具：目标片段出现在第 151 行，前后都是不可混淆的哨兵行。 */
function bigFile(): { text: string; expected: string } {
  const rows: string[] = [];
  for (let i = 1; i <= 300; i += 1) rows.push(`const row${i} = ${i}; // LINE_${i}`);
  const text = `${rows.join('\n')}\n`;
  const expected = text.replace('const row151 = 151;', 'const row151 = LIMIT;');
  return { text, expected };
}

describe('fs.write replace —— 精确局部修改', () => {
  it('C1 单次命中：只改那一处，其余 299 行逐字节不变', async () => {
    const { text, expected } = bigFile();
    writeFileSync(join(sandbox, 'big.ts'), text, 'utf8');
    const outcome = await replace('big.ts', 'const row151 = 151;', 'const row151 = LIMIT;');
    expect(outcome.ok, `单次命中却失败：${outcome.summary}`).toBe(true);
    expect((outcome.data ?? {}).replaced).toBe(1);
    expect(readFileSync(join(sandbox, 'big.ts'), 'utf8')).toBe(expected);
  });

  it('C2 零命中：拒绝，且文件一个字节都不许变', async () => {
    writeFileSync(join(sandbox, 'a.ts'), 'export const A = 1;\n', 'utf8');
    const before = sha('a.ts');
    const outcome = await replace('a.ts', 'export const A = 2;', 'export const A = 3;');
    expect(outcome.ok, '没找到原文却报成功，等于让 Agent 以为改完了').toBe(false);
    expect(outcome.error?.code).toBe('REPLACE_NO_MATCH');
    expect(sha('a.ts'), '零命中时仍然写了文件').toBe(before);
  });

  it('C3 多处命中：拒绝并报出命中次数，文件不许变', async () => {
    writeFileSync(join(sandbox, 'dup.ts'), 'let x = 1;\nlet x = 1;\nlet x = 1;\n', 'utf8');
    const before = sha('dup.ts');
    const outcome = await replace('dup.ts', 'let x = 1;', 'let x = 2;');
    expect(outcome.ok, '三处命中直接替换，会静默改掉另外两处').toBe(false);
    expect(outcome.error?.code).toBe('REPLACE_AMBIGUOUS');
    expect(String((outcome.data ?? {}).matches)).toBe('3');
    expect(sha('dup.ts')).toBe(before);
  });

  it('C4 原文与替换相同：拒绝（空操作不是一次修改）', async () => {
    writeFileSync(join(sandbox, 'same.ts'), 'const a = 1;\n', 'utf8');
    const before = sha('same.ts');
    const outcome = await replace('same.ts', 'const a = 1;', 'const a = 1;');
    expect(outcome.ok, 'oldText 与 newText 相同却报成功，会让 Agent 误以为改动已生效').toBe(false);
    expect(outcome.error?.kind).toBe('invalid_args');
    expect(sha('same.ts')).toBe(before);
  });

  it('C5 多行片段：跨行匹配并替换，行数变化正确', async () => {
    const src = ['function f() {', '  const a = 1;', '  const b = 2;', '  return a + b;', '}', ''].join('\n');
    writeFileSync(join(sandbox, 'multi.ts'), src, 'utf8');
    const outcome = await replace('multi.ts', '  const a = 1;\n  const b = 2;\n', '  return 42;\n');
    expect(outcome.ok, `跨行替换失败：${outcome.summary}`).toBe(true);
    // 两行换一行；下面那句 return a + b; 不在 oldText 范围内，必须原样留着。
    // 第一版这里把它也写没了 —— 又是判据自己算错，不是被测实现的错。
    expect(readFileSync(join(sandbox, 'multi.ts'), 'utf8')).toBe(
      ['function f() {', '  return 42;', '  return a + b;', '}', ''].join('\n'),
    );
  });

  it('C6 CRLF 文件 + LF 片段：能命中，且写回后仍是 CRLF', async () => {
    // Windows 上 git 检出的是 CRLF，而模型给的片段几乎总是 LF。
    // 不做换行归一化就永远匹配不上；归一化后顺手用 LF 写回，会把整份文件的行尾改掉，
    // 于是 git diff 变成「全文件重写」——那正是这一题要消灭的东西。
    const src = 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n';
    writeFileSync(join(sandbox, 'crlf.ts'), src, 'utf8');
    const outcome = await replace('crlf.ts', 'const b = 2;\n', 'const b = 20;\n');
    expect(outcome.ok, `CRLF 文件匹配不到 LF 片段：${outcome.summary}`).toBe(true);
    const after = readFileSync(join(sandbox, 'crlf.ts'), 'utf8');
    expect(after).toBe('const a = 1;\r\nconst b = 20;\r\nconst c = 3;\r\n');
    expect(after.includes('const a = 1;\n'), '写回时把已有行尾换成了 LF，整份文件被「重写」').toBe(false);
  });

  it('C7 文件不存在：报 not_found，而不是去创建它', async () => {
    const outcome = await replace('ghost.ts', 'a', 'b');
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.kind).toBe('not_found');
    expect(existsSync(join(sandbox, 'ghost.ts')), 'replace 不该顺手创建文件').toBe(false);
  });

  it('C8 安全边界不因新增操作而放松：越界与 .git 执行面仍被拒', async () => {
    const escape = await replace('../outside.ts', 'a', 'b');
    expect(escape.ok).toBe(false);
    expect(escape.error?.kind).toBe('security');

    writeFileSync(join(sandbox, 'ok.ts'), 'x\n', 'utf8');
    const tool = await loadTool();
    const hooks = await tool.handler(
      { path: '.git/hooks/pre-commit', operation: 'replace', oldText: 'a', newText: 'b' },
      ctx,
    );
    expect(hooks.ok, '.git/hooks 是「配置即命令」入口，replace 也必须拦住').toBe(false);
    expect(hooks.error?.code).toBe('TOOL_SECURITY_DENIED');
  });
});
