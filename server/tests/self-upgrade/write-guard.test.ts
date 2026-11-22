import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { firstSyntaxError, writeGateFor, WRITE_GATE_OCCUPANCY } from '../../src/services/agent/write-guard.js';
import { fsWriteTool } from '../../src/tools/builtin/fs-write.tool.js';
import type { ToolExecutionContext } from '../../src/types/tool.js';

let root = '';

function ctx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    sessionId: 's1',
    toolCallId: 'tc_1',
    callId: 'c1',
    iteration: 1,
    sandboxRoot: root,
    allowedDirs: [],
    signal: new AbortController().signal,
    reportProgress: () => undefined,
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'write-guard-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('write-guard · writeGateFor 纯规则', () => {
  it('占用低于阈值且无收尾原因时放行', () => {
    expect(writeGateFor(0.5).allowed).toBe(true);
    expect(writeGateFor(WRITE_GATE_OCCUPANCY - 0.01).allowed).toBe(true);
  });

  it('占用达到阈值时拒绝并给出 NOT_RUN 原因', () => {
    const verdict = writeGateFor(WRITE_GATE_OCCUPANCY);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('NOT_RUN');
    expect(verdict.reason).toContain('90.0%');
  });

  it('异常收尾原因（context_full / circuit_open 等）一律拒绝', () => {
    for (const reason of ['context_full', 'circuit_open', 'budget_exhausted', 'max_iterations', 'aborted', 'stream_interrupted']) {
      const verdict = writeGateFor(0.1, reason);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain(reason);
    }
  });

  it('正常收尾原因（stop / converged）不触发写闸', () => {
    expect(writeGateFor(0.1, 'stop').allowed).toBe(true);
    expect(writeGateFor(0.1, 'converged').allowed).toBe(true);
  });
});

describe('write-guard · firstSyntaxError 语法闸', () => {
  it('合法 TS 返回 null', () => {
    expect(firstSyntaxError('export const a = 1;\n', 'a.ts')).toBeNull();
  });

  it('重复函数体 / 孤立残片（第三轮事故形态）被抓出行号', () => {
    const broken = [
      'export function f(): number {',
      '  return 1;',
      '}',
      'export function f(): number {', // 重复粘贴
      '  return 2;',
      // 缺少闭合 —— 孤立残片
    ].join('\n');
    const issue = firstSyntaxError(broken, 'broken.ts');
    expect(issue).not.toBeNull();
    expect(issue!.line).toBeGreaterThan(0);
    expect(issue!.message.length).toBeGreaterThan(0);
  });

  it('未闭合括号报错', () => {
    expect(firstSyntaxError('function g( {\n', 'g.ts')).not.toBeNull();
  });
});

describe('fs.write · 高占用写闸（集成）', () => {
  it('occupancy ≥ 阈值时 create/overwrite 被拒为 NOT_RUN，且文件未落盘', async () => {
    const target = 'src/a.ts';
    for (const operation of ['create', 'overwrite'] as const) {
      const outcome = await fsWriteTool.handler(
        { path: target, operation, content: 'export const a = 1;\n' },
        ctx({ contextOccupancy: 0.95 }),
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.error?.code).toBe('WRITE_GATE_CLOSED');
      expect(outcome.error?.kind).toBe('circuit_open');
      expect(outcome.summary).toContain('NOT_RUN');
    }
    await expect(readFile(path.join(root, target), 'utf8')).rejects.toThrow();
  });

  it('异常收尾原因下 replace 同样被拒', async () => {
    const target = 'b.ts';
    await writeFile(path.join(root, target), 'const x = 1;\n');
    const outcome = await fsWriteTool.handler(
      { path: target, operation: 'replace', oldText: 'const x = 1;', newText: 'const x = 2;' },
      ctx({ finishReason: 'context_full' }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('WRITE_GATE_CLOSED');
    // 原文件未被改动
    expect(await readFile(path.join(root, target), 'utf8')).toBe('const x = 1;\n');
  });

  it('占用正常时写入不受影响（闸门不误伤）', async () => {
    const outcome = await fsWriteTool.handler(
      { path: 'ok.ts', operation: 'create', content: 'export const ok = 1;\n' },
      ctx({ contextOccupancy: 0.3 }),
    );
    expect(outcome.ok).toBe(true);
    expect(await readFile(path.join(root, 'ok.ts'), 'utf8')).toBe('export const ok = 1;\n');
  });
});

describe('fs.write · 写入后语法自检 + 失败回滚（.ts 目标）', () => {
  it('写入残片内容时回滚到写入前状态并返回 SYNTAX_REJECTED', async () => {
    const target = 'core.ts';
    const original = 'export function f(): number {\n  return 1;\n}\n';
    await writeFile(path.join(root, target), original);
    const broken = 'export function f(): number {\n  return 1;\n}\nexport function f(): number {\n  return 2;\n';
    const outcome = await fsWriteTool.handler(
      { path: target, operation: 'overwrite', content: broken },
      ctx({ contextOccupancy: 0.3 }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('SYNTAX_REJECTED');
    expect(outcome.error?.kind).toBe('internal');
    expect(outcome.summary).toContain('已回滚');
    // 文件恢复原样 —— 异常收尾不自毁
    expect(await readFile(path.join(root, target), 'utf8')).toBe(original);
  });

  it('新建文件写入残片时删除该文件（回滚到"不存在"）', async () => {
    const target = 'new-broken.ts';
    const broken = 'function g( {\n';
    const outcome = await fsWriteTool.handler(
      { path: target, operation: 'create', content: broken },
      ctx({ contextOccupancy: 0.3 }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('SYNTAX_REJECTED');
    await expect(readFile(path.join(root, target), 'utf8')).rejects.toThrow();
  });

  it('合法 TS 内容正常落盘（自检不误伤）', async () => {
    const target = 'good.ts';
    const content = 'export function f(): number {\n  return 42;\n}\n';
    const outcome = await fsWriteTool.handler(
      { path: target, operation: 'create', content },
      ctx({ contextOccupancy: 0.3 }),
    );
    expect(outcome.ok).toBe(true);
    expect(await readFile(path.join(root, target), 'utf8')).toBe(content);
  });

  it('非 TS 文件跳过语法自检（闸门只拦代码残片）', async () => {
    const target = 'notes.md';
    const outcome = await fsWriteTool.handler(
      { path: target, operation: 'create', content: '# 标题\n\n未闭合的括号 (\n' },
      ctx({ contextOccupancy: 0.3 }),
    );
    expect(outcome.ok).toBe(true);
  });
});
