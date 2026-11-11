/**
 * code.check 判据 —— 「自检手段」缺失的机械验收。
 *
 * 背景（真实证据，不是假设）：
 *   上一轮自我升级 8 次派单里有 4 次失败，全部是**字面量噪声**——
 *   `1000oca`、`!data mammoth`、`rawLines.length === 0 scrubbed`。
 *   它能写对结构，却写不对字符；而 `sys.exec` 是 hard 审批，无头运行批不了，
 *   所以它改完既不能编译也不能试跑，只能靠外部把编译器原文喂回去。
 *
 * 这里锁的正是那个缺口：一个**只解析、不执行**的自检入口。
 * 只观察 ToolOutcome（ok / error.code / data.line / data.frame），不碰实现方式。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolExecutionContext, ToolDefinition, ToolOutcome } from '../../src/types/tool.js';

let sandbox: string;
let ctx: ToolExecutionContext;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'codecheck-'));
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
    // 宿主的删除守卫偶发超时，清理是 best-effort，不影响结论。
  }
});

/**
 * 动态取工具，而不是顶层 import：模块还不存在时，让**每条判据各自报红**
 * 并带上具体原因，而不是整份文件收集失败、看不出缺的是哪一块。
 */
async function loadTool(): Promise<ToolDefinition> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import('../../src/tools/builtin/code-check.tool.js')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`src/tools/builtin/code-check.tool.ts 不可加载：${err instanceof Error ? err.message : String(err)}`);
  }
  const tool = mod.codeCheckTool as ToolDefinition | undefined;
  if (!tool) throw new Error('code-check.tool.ts 必须导出 codeCheckTool（写闸复用按这个名字找测试引用）');
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

/** 12 行合法 TS：带 interface、泛型、可选参数，确保不是「认识 export 就算过」。 */
const VALID_TS = [
  'export interface Row {',
  '  id: number;',
  '  name?: string;',
  '}',
  '',
  'export function pick<T extends Row>(rows: readonly T[]): T | null {',
  '  for (const row of rows) {',
  '    if (row.id > 0) return row;',
  '  }',
  '  return null;',
  '}',
  '',
].join('\n');

describe('code.check —— 只解析、不执行的自检入口', () => {
  it('C1 已注册进内置工具表，且审批档位允许无头调用', async () => {
    const { BUILTIN_TOOLS } = await import('../../src/tools/builtin/index.js');
    const entry = BUILTIN_TOOLS.find((t) => t.name === 'code.check');
    expect(entry, 'BUILTIN_TOOLS 里没有 code.check —— 工具写了但没注册，运行时永远看不到它').toBeDefined();
    expect(entry?.wireName).toBe('code_check');
    // 这一条是本题的**全部意义**：hard / two_step 在无头会话里批不了，等于没有自检。
    expect(
      ['hard', 'two_step'].includes(String(entry?.approvalMode)),
      `approvalMode=${String(entry?.approvalMode)} 会让无头 Agent 批不下来，自检等于不存在`,
    ).toBe(false);
    expect(entry?.enabled({ sandboxRoot: sandbox, mcpConnected: false })).toBe(true);
  });

  it('C2 合法文件：通过，并报出检查了多少行', async () => {
    const outcome = await check('ok.ts', VALID_TS);
    expect(outcome.ok, `合法 TS 被判失败：${outcome.summary}`).toBe(true);
    // 夹具是 11 行正文 + 结尾换行（"…}\n"）。按「结尾换行不多算一行」的口径应为 11，
    // 与 wc -l 一致。第一版这里写成 12 是**判据自己算错**，工具报 11 才是对的。
    expect(dataOf(outcome).lines).toBe(11);
    expect(outcome.summary).toContain('语法');
  });

  it('C3 数字粘连（1000oca）：判失败，且给出准确行号', async () => {
    // 第 9 行是脏行 —— 这正是上一轮把整个文件写坏的那个笔误。
    const src = ['export const A = 1;', 'export const B = 2;', 'export const C = 3;', '', 'export function f(): number {', '  return A + B + C;', '}', '', 'export const LIMIT = 1000oca;', ''].join('\n');
    const outcome = await check('typo-num.ts', src);
    expect(outcome.ok, '1000oca 是语法错误，却被判通过 —— 那这个工具就只是个摆设').toBe(false);
    expect(outcome.error?.code).toBe('SYNTAX_ERROR');
    expect(dataOf(outcome).line, '行号不对等于没定位：模型拿着错的行走不到出错处').toBe(9);
    expect(String(dataOf(outcome).frame ?? '')).toContain('1000oca');
    expect(String(outcome.error?.message ?? '').length).toBeGreaterThan(0);
  });

  it('C4 凭空多词（!data mammoth）：判失败，且回带出错行原文', async () => {
    const src = ['export function f(data: unknown): null {', '  if (!data) return null;', '  if (!data) return null;', '  if (!data) return null;', '  if (!data mammoth) return null;', '  return null;', '}', ''].join('\n');
    const outcome = await check('typo-word.ts', src);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('SYNTAX_ERROR');
    expect(dataOf(outcome).line).toBe(5);
    expect(String(dataOf(outcome).frame ?? '')).toContain('mammoth');
  });

  it('C5 只解析不执行：顶层 throw / process.exit 的文件仍判通过', async () => {
    // 这条锁死「不执行」的语义。若实现是 eval / import() / spawn 真跑一遍，
    // 那么一个顶层 process.exit(3) 的源码会把检查本身干掉，或者假绿。
    const src = ['process.exit(3);', "throw new Error('boom');", 'export const X = 1;', ''].join('\n');
    const outcome = await check('danger.ts', src);
    expect(outcome.ok, `检查过程执行了被测文件：${outcome.summary}`).toBe(true);
  });

  it('C6 沙箱越界：与语法错误区分开，报 security', async () => {
    writeFileSync(join(sandbox, 'inside.ts'), 'export const A = 1;\n', 'utf8');
    const tool = await loadTool();
    const outcome = await tool.handler({ path: '../escape.ts' }, ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.kind, '越界必须是 security，不能被当成「文件语法有问题」').toBe('security');
  });

  it('C7 非源码扩展名：明确拒绝，不许假装通过', async () => {
    const outcome = await check('notes.md', '# hi\n\nsome text\n');
    expect(outcome.ok, '对 Markdown 返回「语法检查通过」是假绿').toBe(false);
    expect(outcome.error?.code).toBe('UNSUPPORTED_FILE');
  });

  it('C8 文件不存在：报 not_found，而不是语法错误', async () => {
    const tool = await loadTool();
    const outcome = await tool.handler({ path: 'nope.ts' }, ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.kind).toBe('not_found');
  });
});
