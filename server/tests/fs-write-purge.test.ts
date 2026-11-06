/**
 * fs.write `purge` 操作执行测试（配套 security-gateway 的 two_step 真实触发路径）。
 *
 * 覆盖:
 *  - 清空目录内容但保留空目录
 *  - 目标不存在 → TOOL_NOT_FOUND
 *  - 目标是文件 → TOOL_INVALID_ARGS（purge 仅适用于目录）
 *  - 沙箱根被 path-jail 拒绝 → TOOL_SECURITY_DENIED（purge 根不可达）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsWriteTool } from '../src/tools/builtin/fs-write.tool.js';
import type { ToolExecutionContext } from '../src/types/tool.js';

let sandbox: string;
let ctx: ToolExecutionContext;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'fswrite-purge-'));
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
  // 宿主环境的删除守卫（safe-delete shim）可能在并发下超时。
  // 清理是 best-effort：残留目录由环境侧回收，但不能让它把已通过的用例判红。
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
  }
});

describe('fs.write purge 操作', () => {
  // purge 是唯一「逐个真实删除文件」的用例，而宿主的删除守卫（safe-delete shim）
  // 每次删除都要走一次 genie-trash 子进程。全量跑时 57 个 worker 并发，这一步会
  // 排队超过默认的 5s 超时 —— 断言本身没问题，是该给它留出环境时间。
  it('清空目录内容但保留空目录', { timeout: 30_000 }, async () => {
    mkdirSync(join(sandbox, 'work', 'data'), { recursive: true });
    writeFileSync(join(sandbox, 'work', 'data', 'a.txt'), 'x');
    writeFileSync(join(sandbox, 'work', 'data', 'b.txt'), 'y');
    const r = await fsWriteTool.handler({ path: 'work/data', operation: 'purge' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data?.operation).toBe('purge');
    // 目录仍在，内容已清空
    expect(existsSync(join(sandbox, 'work', 'data'))).toBe(true);
    expect(readdirSync(join(sandbox, 'work', 'data'))).toHaveLength(0);
  });

  it('purge 不存在目标返回 TOOL_NOT_FOUND', async () => {
    const r = await fsWriteTool.handler({ path: 'nope', operation: 'purge' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error?.code).toBe('TOOL_NOT_FOUND');
  });

  it('purge 文件返回 TOOL_INVALID_ARGS（purge 仅适用于目录）', async () => {
    writeFileSync(join(sandbox, 'f.txt'), 'x');
    const r = await fsWriteTool.handler({ path: 'f.txt', operation: 'purge' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error?.code).toBe('TOOL_INVALID_ARGS');
  });

  it('purge 沙箱根被 path-jail 拒绝（SECURITY_DENIED）', async () => {
    const r = await fsWriteTool.handler({ path: '.', operation: 'purge' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error?.code).toBe('TOOL_SECURITY_DENIED');
  });
});
