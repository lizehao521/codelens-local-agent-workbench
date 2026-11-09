/**
 * 提案准入的自证（C3）：每条准入条件都必须能被破坏夹具打红。
 *
 * 这里验证的是「Agent 自己扩任务空间」这条路最关键的一环 ——
 * 它出的题必须有判别力，而不是自己出简单题自己拿满分。
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildMutants,
  mutationScore,
  promoteProposal,
  validateProposal,
  type EvalProposal,
} from '../src/services/eval/propose.js';
import { allSuites } from '../src/services/eval/suites.js';
import { evalProposeTool } from '../src/tools/builtin/eval-propose.tool.js';

function goodProposal(): EvalProposal {
  return {
    id: 'range_sum',
    title: '区间求和',
    exportName: 'rangeSum',
    reference: `function rangeSum(start, end) {
  let total = 0;
  for (let i = start; i <= end; i += 1) total += i;
  return total;
}
module.exports = { rangeSum };`,
    buggy: `function rangeSum(start, end) {
  let total = 0;
  for (let i = start; i < end; i += 1) total += i;
  return total;
}
module.exports = { rangeSum };`,
    publicCases: [
      { name: '1..3', args: [1, 3], expected: 6 },
      { name: '5..5', args: [5, 5], expected: 5 },
    ],
    hiddenCases: [
      { name: '0..0', args: [0, 0], expected: 0 },
      { name: '1..4', args: [1, 4], expected: 10 },
      { name: '负数区间', args: [-3, -1], expected: -6 },
    ],
    sourceUrls: ['https://example.com/off-by-one-loop'],
  };
}

function tmpSandbox(): string {
  const base = mkdtempSync(path.join(os.tmpdir(), 'codelens-prop-'));
  const sandbox = path.join(base, 'workspace');
  mkdirSync(sandbox, { recursive: true });
  return sandbox;
}

describe('提案准入 · 变异验证', () => {
  it('好提案通过：参考实现自洽、缺陷真的红、变异体被杀掉', () => {
    const p = goodProposal();
    const v = validateProposal(p);
    expect(v.mutation.total).toBeGreaterThanOrEqual(3);
    expect(v.mutation.score).toBeGreaterThanOrEqual(0.6);
    expect(v.checks.every((c) => c.ok)).toBe(true);
    expect(v.accepted).toBe(true);
  });

  it('参考实现跑不过自己的用例 → 拒收', () => {
    const p = goodProposal();
    p.reference = p.reference.replace('i <= end', 'i < end'); // 参考实现自己就错了
    const v = validateProposal(p);
    expect(v.accepted).toBe(false);
    expect(v.checks.find((c) => c.name === '参考实现全通过')!.ok).toBe(false);
  });

  it('「缺陷实现」其实没缺陷 → 拒收（没有真实失败模式）', () => {
    const p = goodProposal();
    p.buggy = p.reference;
    const v = validateProposal(p);
    expect(v.accepted).toBe(false);
    expect(v.checks.find((c) => c.name === '缺陷实现能被公开用例发现')!.ok).toBe(false);
  });

  it('隐藏用例照抄公开用例 → 拒收（隐藏集没有独立信号）', () => {
    const p = goodProposal();
    p.hiddenCases = [...p.hiddenCases, { name: '抄一条公开的', args: [1, 3], expected: 6 }];
    const v = validateProposal(p);
    expect(v.accepted).toBe(false);
    expect(v.checks.find((c) => c.name === '隐藏用例与公开用例不重复')!.ok).toBe(false);
  });

  it('用例/实现太单薄、变异体不足 → 拒收（测不出判别力）', () => {
    const p = goodProposal();
    p.id = 'double_only';
    p.title = '单运算符实现';
    p.reference = `function double(n) {
  return n * 2;
}
module.exports = { double };`;
    p.buggy = `function double(n) {
  return n + 2;
}
module.exports = { double };`;
    p.publicCases = [
      { name: '2→4', args: [2], expected: 4 },
      { name: '5→10', args: [5], expected: 10 },
    ];
    p.hiddenCases = [
      { name: '0→0', args: [0], expected: 0 },
      { name: '负数', args: [-3], expected: -6 },
      { name: '小数', args: [1.5], expected: 3 },
    ];
    const v = validateProposal(p);
    expect(v.accepted).toBe(false);
    expect(v.checks.find((c) => c.name.startsWith('变异验证'))!.ok).toBe(false);
  });

  it('变异体来自参考实现，且都是可执行的源码', () => {
    const mutants = buildMutants(goodProposal().reference);
    expect(mutants.length).toBeGreaterThan(0);
    for (const m of mutants) expect(m.source).not.toBe(goodProposal().reference);
    expect(mutationScore(goodProposal()).killed).toBeGreaterThan(0);
  });
});

describe('提案晋升', () => {
  it('晋升把缺陷实现写进沙箱、把套件定义写到沙箱外', () => {
    const sandbox = tmpSandbox();
    const p = goodProposal();
    const out = promoteProposal(sandbox, p);

    // 待修实现落在沙箱内（Agent 可读可改）
    expect(existsSync(path.join(sandbox, out.implPath))).toBe(true);
    expect(readFileSync(path.join(sandbox, out.implPath), 'utf8')).toContain('i < end');

    // 套件定义落在沙箱外（Agent 改不到判据）
    expect(out.suitePath.startsWith(sandbox)).toBe(false);
    const suite = JSON.parse(readFileSync(out.suitePath, 'utf8'));
    expect(suite.id).toBe('range_sum');
    expect(suite.hiddenCases).toHaveLength(3);

    // 晋升后进入测量集
    expect(allSuites(sandbox).some((s) => s.id === 'range_sum')).toBe(true);
  });
});

describe('eval.propose 工具', () => {
  it('工具已注册且参数契约稳定', () => {
    expect(evalProposeTool.wireName).toBe('eval_propose');
    expect(evalProposeTool.approvalMode).toBe('none');
    expect(evalProposeTool.inputSchema.required).toEqual([
      'id',
      'title',
      'exportName',
      'reference',
      'buggy',
      'publicCases',
      'hiddenCases',
      'sourceUrls',
    ]);
  });
});
