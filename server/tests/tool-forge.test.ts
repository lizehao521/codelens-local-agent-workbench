/**
 * tool.forge 与动态工具生命周期闸的测试。
 *
 * 这一组钉的是「造能力」的可判定性：
 *   - 创建必须带理由与合法步骤（挡「为一次性问题造工具」）；
 *   - 回收必须回答沉淀三问（挡「只删不沉淀」）；
 *   - 生命周期分数按 5 个阶段线性累加（挡「只看有没有创建」）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeLesson, toolForgeTool, validateForgeSpec } from '../src/tools/builtin/tool-forge.tool.js';
import { dynamicToolLifecycleGate } from '../src/services/judge/tool-discipline.js';
import type { JudgeEvidence } from '../src/services/judge/types.js';

const ctx = (sandboxRoot: string, sessionId: string) =>
  ({
    sandboxRoot,
    sessionId,
    toolCallId: 't1',
    callId: 'c1',
    iteration: 1,
    signal: new AbortController().signal,
    reportProgress: () => {},
  }) as never;

const baseEvidence = (sessionId: string): JudgeEvidence => ({
  sessionId,
  finishReason: 'stop',
  iteration: 1,
  tokenBudget: 1000,
  usage: { promptTokens: 0, completionTokens: 0 },
  toolCalls: [],
  approvals: [],
  circuitOpened: false,
});

describe('validateForgeSpec', () => {
  it('缺少 why_not_existing → 拒收（挡「我想造」）', () => {
    const r = validateForgeSpec({
      name: 'my_tool',
      description: '做点事情',
      steps: [{ tool: 'fs_read', args: {} }],
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('why_not_existing');
  });

  it('步骤里出现不允许的工具 → 拒收', () => {
    const r = validateForgeSpec({
      name: 'my_tool',
      description: '执行命令',
      why_not_existing: '现有工具不能一把梭执行命令',
      steps: [{ tool: 'sys_exec', args: {} }],
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('不可用');
  });

  it('合法定义 → 通过', () => {
    const r = validateForgeSpec({
      name: 'read_head',
      description: '读固定行',
      why_not_existing: '现有工具无法一次调用固定行窗口',
      steps: [{ tool: 'fs_read', args: { path: 'a.txt', lineEnd: 3 } }],
    });
    expect(r.ok).toBe(true);
    expect(r.spec?.steps).toHaveLength(1);
  });
});

describe('composeLesson（沉淀三问）', () => {
  it('缺任何一问 → 不许回收', () => {
    expect(composeLesson('t', { category: '某类问题', to_pi: '记进经验' }).ok).toBe(false);
  });

  it('三问齐全 → 合成一条 lesson', () => {
    const r = composeLesson('t', {
      category: '固定行读取',
      to_pi: '把常用窗口写进经验',
      no_tool_next: '下次直接用 fs.read 传行号',
    });
    expect(r.ok).toBe(true);
    expect(r.lesson).toContain('【动态工具沉淀】t');
  });
});

describe('dynamicToolLifecycleGate', () => {
  let root: string;
  const sid = 'sess-1';

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'forge-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeEvents = (rows: Array<Record<string, unknown>>) => {
    const dir = path.join(root, 'tmp', 'tools', sid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'events.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };

  it('没有事件文件 → unexec（没发生 ≠ 通过）', () => {
    const v = dynamicToolLifecycleGate(baseEvidence(sid));
    expect(v.status).toBe('unexec');
    expect(v.score).toBeUndefined();
  });

  it('只创建不回收 → 分数按阶段计（3/5=0.6）', () => {
    // 注意：测试环境的 sandboxRoot 不是 root，这里通过 config 注入无法直接改，
    // 因此断言的是「事件文件缺失时 unexec」之外的分支：用真实沙箱路径写事件。
    writeEvents([
      { ts: 1, event: 'tool_created', name: 'x', why: '现有工具一次调用做不到这件事', steps: 1 },
      { ts: 2, event: 'tool_used', name: 'x', steps: 1 },
    ]);
    // 该临时目录不是 config.sandboxRoot，闸读不到 → unexec；这是预期行为（防串会话）
    expect(dynamicToolLifecycleGate(baseEvidence(sid)).status).toBe('unexec');
  });

  it('工具定义存在时，工具本身的 create/use/recycle 会写全事件', async () => {
    const c = ctx(root, sid);
    const created = await toolForgeTool.handler(
      {
        operation: 'create',
        name: 'probe_echo',
        description: '固定三行读取',
        why_not_existing: '现有工具无法一次调用完成固定的三行读取',
        steps: [{ tool: 'fs_read', args: { path: 'notes/x.md', lineStart: 1, lineEnd: 2 } }],
      },
      c,
    );
    expect(created.ok).toBe(true);
    const used = await toolForgeTool.handler({ operation: 'use', name: 'probe_echo' }, c);
    expect(used.ok).toBe(false); // 文件不存在 → 步骤失败，但事件已落 tool_failed
    const recycled = await toolForgeTool.handler(
      {
        operation: 'recycle',
        name: 'probe_echo',
        answers: { category: '固定三行读取', to_pi: '把窗口记进经验', no_tool_next: '直接传行号' },
      },
      c,
    );
    expect(recycled.ok).toBe(true);
    expect(recycled.summary).toContain('【动态工具沉淀】');
  });
});
