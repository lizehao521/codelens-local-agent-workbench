/**
 * 长任务分解纯函数的机械判据自证。
 * 测试文件不在 tsc include 内，必须靠 vitest 实跑验收。
 */
import { describe, it, expect } from 'vitest';
import {
  decompose,
  unitToPrompt,
  DecomposeError,
  type GoalSpec,
  type RepoFacts,
} from '../src/services/plan/task-decomposer.js';

const FACTS: RepoFacts = {
  tsconfigInclude: ['src'],
  defaultMaxToolCalls: 40,
  newFileMaxLines: 300,
  frozenFiles: {},
};

function goalWith(deliverables: GoalSpec['deliverables']): GoalSpec {
  return { id: 'g1', title: '实现特性X', deliverables };
}

describe('decompose：长任务分解纯函数', () => {
  it('确定性：同输入两次调用 deepEqual', () => {
    const goal = goalWith([
      { key: 'a', path: 'src/services/a.ts', kind: 'impl' },
      { key: 'b', path: 'tests/b.test.ts', kind: 'test', dependsOn: ['a'] },
    ]);
    expect(decompose(goal, FACTS)).toEqual(decompose(goal, FACTS));
  });

  it('单写点：每个单元 writeScope 长度恒为 1', () => {
    const units = decompose(goalWith([
      { key: 'a', path: 'src/services/a.ts', kind: 'impl' },
      { key: 'b', path: 'src/services/b.ts', kind: 'impl' },
    ]), FACTS);
    expect(units.length).toBe(2);
    for (const u of units) expect(u.writeScope).toHaveLength(1);
  });

  it('DAG 依赖映射：dependsOn 映射到单元 id，id 稳定排序', () => {
    const units = decompose(goalWith([
      { key: 'impl', path: 'src/services/x.ts', kind: 'impl' },
      { key: 'test', path: 'tests/x.test.ts', kind: 'test', dependsOn: ['impl'] },
    ]), FACTS);
    const impl = units.find((u) => u.title.includes('实现'))!;
    const test = units.find((u) => u.title.includes('测试'))!;
    expect(impl.id).toBe('u01');
    expect(test.id).toBe('u02');
    expect(test.deps).toContain(impl.id);
  });

  it('拓扑序编号：被依赖者编号更小，数组顺序即回丢顺序', () => {
    // recall 依赖 schema，尽管 recall 的 path 字典序在前，schema 必须拿到 u01。
    const units = decompose(goalWith([
      { key: 'recall', path: 'src/services/memory/lesson-recall.ts', kind: 'impl', dependsOn: ['schema'] },
      { key: 'schema', path: 'src/services/memory/lesson-schema.ts', kind: 'impl' },
    ]), FACTS);
    const schema = units.find((u) => u.title.includes('schema'))!;
    const recall = units.find((u) => u.title.includes('recall'))!;
    expect(schema.id < recall.id).toBe(true);
    expect(units[0].id).toBe(schema.id);
    expect(recall.deps).toContain(schema.id);
  });

  it('成环抛 DecomposeError', () => {
    const goal = goalWith([
      { key: 'A', path: 'src/a.ts', kind: 'impl', dependsOn: ['B'] },
      { key: 'B', path: 'src/b.ts', kind: 'impl', dependsOn: ['A'] },
    ]);
    expect(() => decompose(goal, FACTS)).toThrow(DecomposeError);
  });

  it('重复 key 抛 DecomposeError', () => {
    const goal = goalWith([
      { key: 'A', path: 'src/a.ts', kind: 'impl' },
      { key: 'A', path: 'src/b.ts', kind: 'impl' },
    ]);
    expect(() => decompose(goal, FACTS)).toThrow(DecomposeError);
  });

  it('验收齐备：≥3 条；impl 在 src 含 tsc；test 含 vitest；有签名含 signature', () => {
    const units = decompose(goalWith([
      { key: 'a', path: 'src/services/a.ts', kind: 'impl', signature: 'export function a(): void' },
      { key: 'b', path: 'tests/b.test.ts', kind: 'test' },
    ]), FACTS);
    const impl = units.find((u) => u.title.includes('实现'))!;
    const test = units.find((u) => u.title.includes('测试'))!;
    expect(impl.acceptance.length).toBeGreaterThanOrEqual(3);
    expect(test.acceptance.length).toBeGreaterThanOrEqual(3);
    expect(impl.acceptance.some((c) => c.kind === 'tsc')).toBe(true);
    expect(test.acceptance.some((c) => c.kind === 'vitest')).toBe(true);
    const sig = impl.acceptance.find((c) => c.kind === 'signature');
    expect(sig?.contains).toBe('export function a(): void');
  });

  it('可回丢：unitToPrompt 含目标路径与 fs.write，无 contract 也能序列化', () => {
    const unit = decompose(goalWith([
      { key: 'a', path: 'src/services/a.ts', kind: 'impl' },
    ]), FACTS)[0];
    const prompt = unitToPrompt(unit);
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('src/services/a.ts');
    expect(prompt).toContain('fs.write');
  });

  it('预算与执行铁律：toolCalls=1、firstToolCall=fs.write、readScope 空', () => {
    const unit = decompose(goalWith([
      { key: 'a', path: 'src/services/a.ts', kind: 'impl' },
    ]), FACTS)[0];
    expect(unit.budget.toolCalls).toBe(1);
    expect(unit.execution.firstToolCall).toBe('fs.write');
    expect(unit.readScope).toEqual([]);
  });
});


/**
 * unitToPrompt 输出格式契约（强 schema 锁）。
 * 外层调度脚本把这段文本当 user message 喂给 CodeLens，格式即隐式 API。
 * 上面"可回丢"用例只锁了路径与 fs.write，锁不住标签名/铁律/验收结构；
 * 本块逐行锁定，任何格式漂移（删标签、改铁律、改验收行）都会变红——能杀变异体。
 */
describe('unitToPrompt：输出格式契约强锁（防隐式契约漂移）', () => {
  function oneUnit(over: Partial<GoalSpec['deliverables'][number]> = {}) {
    return decompose(goalWith([
      { key: 'a', path: 'src/services/a.ts', kind: 'impl', exportName: 'a', signature: 'export function a(): void', ...over },
    ]), FACTS)[0];
  }

  it('首行是【短任务 uXX】+ 标题，且标题带「实现」', () => {
    const lines = unitToPrompt(oneUnit()).split('\n');
    expect(lines[0]).toMatch(/^【短任务 u\d{2}】/);
    expect(lines[0]).toContain('实现');
  });

  it('锁住四个关键标签行：目标 / 唯一写点 / 铁律 / 预算，顺序固定', () => {
    const lines = unitToPrompt(oneUnit()).split('\n');
    const idx = (prefix: string) => lines.findIndex((l) => l.startsWith(prefix));
    const goal = idx('目标：');
    const write = idx('唯一写点：');
    const iron = idx('铁律：');
    const budget = idx('预算：');
    expect(goal).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(goal);
    expect(iron).toBeGreaterThan(write);
    expect(budget).toBeGreaterThan(iron);
  });

  it('唯一写点行必须带目标路径，且只有一处', () => {
    const lines = unitToPrompt(oneUnit()).split('\n');
    const writeLine = lines.find((l) => l.startsWith('唯一写点：'))!;
    expect(writeLine).toBe('唯一写点：src/services/a.ts');
    expect(lines.filter((l) => l.startsWith('唯一写点：'))).toHaveLength(1);
  });

  it('铁律行锁住「第一个工具调用必须是 fs.write」与「禁止读码」「收尾」三个语义', () => {
    const lines = unitToPrompt(oneUnit()).split('\n');
    const iron = lines.find((l) => l.startsWith('铁律：'))!;
    expect(iron).toContain('fs.write');
    expect(iron).toContain('禁止读码');
    expect(iron).toContain('收尾');
  });

  it('客观签名段锁住「直接用，勿读码」与签名原文', () => {
    const prompt = unitToPrompt(oneUnit());
    expect(prompt).toContain('客观签名（直接用，勿读码）：');
    expect(prompt).toContain('export function a(): void');
  });

  it('验收判据段锁住块头与每条判据 kind，impl in src 含 diff/ratchet/tsc/signature', () => {
    const prompt = unitToPrompt(oneUnit());
    expect(prompt).toContain('验收判据：');
    for (const kind of ['diff-check', 'ratchet', 'tsc', 'signature']) {
      expect(prompt).toContain(kind);
    }
    // 判据行形如 "- <id>: <kind> | ..."，至少 4 条
    const checkLines = prompt.split('\n').filter((l) => /^- \w+: /.test(l));
    expect(checkLines.length).toBeGreaterThanOrEqual(4);
  });

  it('预算行锁住单次工具调用 1 与新文件行数上限', () => {
    const lines = unitToPrompt(oneUnit()).split('\n');
    const budget = lines.find((l) => l.startsWith('预算：'))!;
    expect(budget).toContain('单次工具调用 1');
    expect(budget).toContain('≤300 行');
  });

  it('无 contract 的单元：不产出客观签名段，但其余格式标签齐全', () => {
    const prompt = unitToPrompt(oneUnit({ signature: undefined, exportName: undefined }));
    expect(prompt).not.toContain('客观签名（直接用，勿读码）：');
    for (const tag of ['【短任务', '目标：', '唯一写点：', '铁律：', '验收判据：', '预算：']) {
      expect(prompt).toContain(tag);
    }
  });

  it('确定性：同一单元两次序列化逐字相同', () => {
    const unit = oneUnit();
    expect(unitToPrompt(unit)).toBe(unitToPrompt(unit));
  });
});
