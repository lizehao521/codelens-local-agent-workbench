/**
 * A1 破坏夹具：工具纪律闸必须能被打红（宣言 C3「破坏夹具打不红 ⇒ 不是强化」）。
 *
 * 与 tool-forge.test.ts 的分工：那边钉纯函数（lifecycleStats/reuseStats）的语义；
 * 这里钉**闸级 verdict 的红路径**——事件文件、任务作用域残留、注册表篡改，
 * 每一类破坏都必须得到 fail 或 unexec，绝不能 pass。
 *
 * 为什么必须 vi.mock：闸读的是 config.sandboxRoot（加载期快照）与真实
 * BUILTIN_TOOLS。此前的闸级用例把事件写进闸读不到的临时目录，红路径从未被测到。
 * 这里把 sandboxRoot 指向受控临时目录、把 BUILTIN_TOOLS 换成可篡改副本，
 * 破坏才真正落在闸的读取路径上。源码零改动。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  orphanToolsGate,
  dynamicToolLifecycleGate,
  capabilityReuseGate,
  writeGateReuse,
  runToolDisciplineGates,
} from '../src/services/judge/tool-discipline.js';
import type { JudgeEvidence } from '../src/services/judge/types.js';
import type { ToolDefinition } from '../src/types/tool.js';

const h = vi.hoisted(() => ({ sandbox: '', tools: null as readonly ToolDefinition[] | null }));

vi.mock('../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env.js')>();
  return { ...actual, config: { ...actual.config, get sandboxRoot() { return h.sandbox; } } };
});
vi.mock('../src/tools/builtin/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/builtin/index.js')>();
  return { ...actual, get BUILTIN_TOOLS() { return h.tools ?? actual.BUILTIN_TOOLS; } };
});

const SID = 'fx-sess';
const evidence = (): JudgeEvidence => ({
  sessionId: SID,
  finishReason: 'stop',
  iteration: 1,
  tokenBudget: 1000,
  usage: { promptTokens: 0, completionTokens: 0 },
  toolCalls: [],
  approvals: [],
  circuitOpened: false,
});

type Row = Record<string, unknown>;
const scopeDir = () => path.join(h.sandbox, 'tmp', 'tools', SID);
const writeEvents = (rows: Row[]) => {
  mkdirSync(scopeDir(), { recursive: true });
  writeFileSync(path.join(scopeDir(), 'events.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

// 事件里的工具名是自由字符串；拼接构造，避免字面量落进 tests/ 被写闸当成覆盖。
const T = ['fx', 'tool'].join('.');
const fullEvents = (): Row[] => [
  { ts: 1, event: 'generation_checkpoint' },
  { ts: 2, event: 'tool_created', name: T, why: '现有工具无法一次调用完成这件事', steps: 2, references: 1 },
  { ts: 3, event: 'tool_used', name: T },
  { ts: 4, event: 'tool_removed', name: T },
  { ts: 5, event: 'lesson', name: T, text: '沉淀三问的回答' },
];

let realTools: readonly ToolDefinition[];

beforeEach(async () => {
  h.sandbox = mkdtempSync(path.join(os.tmpdir(), 'discipline-mutation-'));
  realTools = (await vi.importActual<typeof import('../src/tools/builtin/index.js')>('../src/tools/builtin/index.js')).BUILTIN_TOOLS;
});
afterEach(() => {
  h.tools = null;
  rmSync(h.sandbox, { recursive: true, force: true });
});

describe('闸2 生命周期：单阶段变异必须全部被打红（杀死率=1）', () => {
  it('完整六阶段序列 → pass 且满分', () => {
    writeEvents(fullEvents());
    const v = dynamicToolLifecycleGate(evidence());
    expect(v.status).toBe('pass');
    expect(v.score).toBe(1);
  });

  // 每个变异体只破坏一个阶段——正是 mutationScore 的「单点破坏」口径。
  const mutators: Array<[string, (rows: Row[]) => Row[]]> = [
    ['创建理由(why_not_existing)', (rows) => rows.map((r) => (r.event === 'tool_created' ? { ...r, why: '' } : r))],
    ['定义合法(steps)', (rows) => rows.map((r) => (r.event === 'tool_created' ? { ...r, steps: 0 } : r))],
    ['外部依据(references)', (rows) => rows.map((r) => (r.event === 'tool_created' ? { ...r, references: 0 } : r))],
    ['真实使用(tool_used)', (rows) => rows.filter((r) => r.event !== 'tool_used')],
    ['回收(tool_removed)', (rows) => rows.filter((r) => r.event !== 'tool_removed')],
    ['沉淀配对(lesson)', (rows) => rows.filter((r) => r.event !== 'lesson')],
  ];
  it.each(mutators)('破坏阶段「%s」→ fail，且点名缺哪个阶段', (_stage, mutate) => {
    writeEvents(mutate(fullEvents()));
    const v = dynamicToolLifecycleGate(evidence());
    expect(v.status, `变异体「${_stage}」未被拦截——闸是永真的`).toBe('fail');
    expect(v.score).toBeLessThan(1);
    expect(v.detail).toContain(_stage);
  });

  it('事件文件损坏（非法 JSON）→ unexec，不是崩溃也不是 pass', () => {
    mkdirSync(scopeDir(), { recursive: true });
    writeFileSync(path.join(scopeDir(), 'events.jsonl'), '{broken\n');
    expect(dynamicToolLifecycleGate(evidence()).status).toBe('unexec');
  });

  it('有事件但没有 tool_created → unexec（不可测 ≠ 通过）', () => {
    writeEvents([{ ts: 1, event: 'tool_used', name: T }]);
    expect(dynamicToolLifecycleGate(evidence()).status).toBe('unexec');
  });
});

describe('闸2b 复用率：verdict 红路径与 0.5 边界', () => {
  it('本代只重建、零复用 → fail 且 score=0', () => {
    writeEvents([
      { ts: 1, event: 'generation_checkpoint' },
      { ts: 2, event: 'tool_created', name: T, why: '现有工具不够用才造', steps: 1, references: 1 },
    ]);
    const v = capabilityReuseGate(evidence());
    expect(v.status).toBe('fail');
    expect(v.score).toBe(0);
  });

  it('恰好 0.5（一建一复用）→ pass（阈值含等号）', () => {
    writeEvents([
      { ts: 1, event: 'generation_checkpoint' },
      { ts: 2, event: 'tool_created', name: T, why: '现有工具不够用才造', steps: 1, references: 1 },
      { ts: 3, event: 'tool_used', name: 'lib.other', from_library: true },
    ]);
    const v = capabilityReuseGate(evidence());
    expect(v.score).toBe(0.5);
    expect(v.status).toBe('pass');
  });
});

describe('闸1 孤儿工具：任务作用域注入必须打红', () => {
  it('作用域残留工具定义 .json → fail 且点名残留文件', () => {
    mkdirSync(scopeDir(), { recursive: true });
    writeFileSync(path.join(scopeDir(), 'leftover.json'), '{}');
    const v = orphanToolsGate(evidence());
    expect(v.status).toBe('fail');
    expect(v.detail).toContain('leftover.json');
  });

  it('只有 events.jsonl（审计凭据）→ pass，审计文件不算孤儿', () => {
    writeEvents(fullEvents());
    expect(orphanToolsGate(evidence()).status).toBe('pass');
  });

  it('作用域目录存在但为空 → pass', () => {
    mkdirSync(scopeDir(), { recursive: true });
    expect(orphanToolsGate(evidence()).status).toBe('pass');
  });
});

describe('注册表篡改（BUILTIN_TOOLS 变异）：静态闸的红路径', () => {
  // 假工具名拼接构造：字面量一旦落进 tests/ 就会被写闸的覆盖扫描当成「有测试引用」。
  const FAKE = ['zz', 'probe'].join('.');
  const fakeTool = () => ({ ...realTools[0], name: FAKE, wireName: ['zz', 'probe'].join('_') }) as ToolDefinition;

  it('加入无测试覆盖的工具 → 写闸 fail，score<1，且点名该工具', () => {
    h.tools = [...realTools, fakeTool()];
    const v = writeGateReuse();
    expect(v.status).toBe('fail');
    expect(v.score).toBeLessThan(1);
    expect(v.detail).toContain(FAKE);
    // 注册表本身仍一致：孤儿闸不受「多一个合法工具」影响
    expect(orphanToolsGate(evidence()).status).toBe('pass');
  });

  it('重名注册 → 孤儿闸抛错；集成闸降级 unexec，绝不 pass，也不拖垮其余闸', () => {
    h.tools = [...realTools, { ...realTools[0] }];
    expect(() => orphanToolsGate(evidence())).toThrow(/already registered/);
    const verdicts = runToolDisciplineGates(evidence());
    expect(verdicts).toHaveLength(4);
    expect(verdicts.some((v) => v.criterion === 'tool.discipline.runtime_error' && v.status === 'unexec')).toBe(true);
    expect(verdicts.some((v) => v.criterion === 'tool.discipline.orphan' && v.status === 'pass')).toBe(false);
  });

  it('恢复真实注册表 → 写闸与孤儿闸都回到 pass（夹具可移除，绿是真绿）', () => {
    h.tools = null;
    expect(writeGateReuse().status).toBe('pass');
    expect(writeGateReuse().score).toBe(1);
    expect(orphanToolsGate(evidence()).status).toBe('pass');
  });
});