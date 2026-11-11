/**
 * test.run 第一步判据：骨架与安全边界。
 *
 * ── 为什么拆成两步 ────────────────────────────────────────
 * 一次性「写完 200 行 + 注册 + 自查」在实测里连续失败：模型会先花 9~17 次工具调用
 * 研究现成实现，再写 24k~30k 字符的「计划」，8k 的输出上限在计划阶段就用完，
 * 一个字节没落盘。二分实验证实链路没问题——把任务缩到「创建一个文件、写一句话」，
 * 它 91 秒内就调了两次工具并落盘。所以问题不在模型，在粒度：
 * 一步要验证的东西太多，它就没有「写完能立刻看见结果」的锚点。
 *
 * 第一步只要求：文件存在、元数据正确、三个校验按对顺序做、注册进 BUILTIN_TOOLS，
 * 并且**对合法测试文件诚实返回 NOT_IMPLEMENTED**（不许假装通过）。
 * 执行逻辑留给第二步（tests/self-upgrade/test-run.test.ts 的 C1–C10）。
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolExecutionContext, ToolDefinition, ToolOutcome } from '../../src/types/tool.js';

const ROOT = process.cwd();
const FIXTURE = 'tests/self-upgrade/fixtures/probe.test.ts';

const ctx: ToolExecutionContext = {
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: ROOT,
  signal: new AbortController().signal,
  reportProgress: () => {},
};

async function loadTool(): Promise<ToolDefinition> {
  const mod = (await import('../../src/tools/builtin/test-run.tool.js')) as Record<string, unknown>;
  const tool = mod.testRunTool as ToolDefinition | undefined;
  if (!tool) throw new Error('test-run.tool.ts 必须导出 testRunTool');
  return tool;
}

async function run(args: Record<string, unknown>): Promise<ToolOutcome> {
  const tool = await loadTool();
  return tool.handler(args, ctx);
}

describe('test.run 第一步 —— 骨架与安全边界', { timeout: 60_000 }, () => {
  it('A1 元数据必须是约定值', async () => {
    const tool = await loadTool();
    expect(tool.name).toBe('test.run');
    expect(tool.wireName).toBe('test_run');
    expect(tool.displayName).toBe('跑测试');
    expect(tool.category).toBe('compute');
    expect(tool.risk).toBe('medium');
    expect(tool.approvalMode).toBe('none');
    expect(tool.idempotent).toBe(false);
    expect(tool.source).toBe('builtin');
    expect(tool.enabled({ sandboxRoot: ROOT, mcpConnected: false })).toBe(true);
    const props = tool.inputSchema.properties ?? {};
    expect(Object.keys(props).sort()).toEqual(['file', 'timeoutMs']);
    expect(tool.inputSchema.required).toEqual(['file']);
  });

  it('A2 越界必须先按安全拒绝（不是 invalid_args）', async () => {
    for (const file of ['tests/../package.json', '../../etc/passwd', 'C:/Windows/win.ini', '/etc/passwd']) {
      const o = await run({ file });
      expect(o.ok, `${file} 不该被接受`).toBe(false);
      expect(o.error?.kind, `${file} 应按安全拒绝`).toBe('security');
    }
  });

  it('A3 非测试文件一律 UNSUPPORTED_TARGET / invalid_args', async () => {
    for (const file of ['src/app.ts', 'package.json', 'tests/self-upgrade/code-check.test.ts.bak']) {
      const o = await run({ file });
      expect(o.ok).toBe(false);
      expect(o.error?.code).toBe('UNSUPPORTED_TARGET');
      expect(o.error?.kind).toBe('invalid_args');
    }
  });

  it('A4 文件不存在要能与其它失败区分', async () => {
    const o = await run({ file: 'tests/self-upgrade/does-not-exist.test.ts' });
    expect(o.ok).toBe(false);
    expect(o.error?.kind).toBe('not_found');
  });

  it('A5 shell 元字符不得被当作命令执行', async () => {
    for (const file of [
      'tests/self-upgrade/fixtures/probe.test.ts && calc',
      'tests/$(whoami).test.ts',
      'tests/self-upgrade/fixtures/probe.test.ts|calc',
    ]) {
      const o = await run({ file });
      expect(o.ok, `${file} 不该被接受`).toBe(false);
    }
  });

  it('A6 不得假装成功：要么诚实说没实现，要么给出真实统计', async () => {
    const o = await run({ file: FIXTURE });
    if (o.ok) {
      // 声称成功就必须给出真实统计（夹具正好 4 条用例）：
      // 「ok:true 但数字是编的」就是假装成功，这条要抓。
      const d = (o.data ?? {}) as Record<string, unknown>;
      expect(d.total, '声称成功却没给总数').toBe(4);
      expect(d.failed, '声称成功却有失败用例').toBe(0);
    } else {
      // 骨架阶段：诚实报「还没实现」，不许含糊。
      expect(o.error?.code).toBe('NOT_IMPLEMENTED');
    }
  });

  it('A7 必须注册进 BUILTIN_TOOLS', async () => {
    const tool = await loadTool();
    const registry = (await import('../../src/tools/builtin/index.js')) as { BUILTIN_TOOLS?: { name?: string }[] };
    const names = (registry.BUILTIN_TOOLS ?? []).map((t) => t.name);
    expect(names).toContain(tool.name);
    for (const name of ['fs.read', 'fs.write', 'code.check', 'sys.exec']) expect(names).toContain(name);
  });

  it('A8 夹具存在（判据自身前置）', () => {
    expect(existsSync(join(ROOT, FIXTURE)), '判据夹具 probe.test.ts 丢失').toBe(true);
  });
});
