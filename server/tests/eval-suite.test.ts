/**
 * 代码修复任务族的判据自证（C3：每条判据都必须能被破坏夹具打红）。
 *
 * 这里验证三件事：
 *  1) 正确实现 → 全量用例满分（判据可以变绿）；
 *  2) 只满足公开用例 → 隐藏用例打红（防过拟合不是口号，是分数）；
 *  3) 本轮没跑过 eval.run → 不产出判据（不污染无关会话的覆盖率）。
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runEvalBattery, runSuite, deepEqual } from '../src/services/eval/runner.js';
import { EVAL_SUITES, EVAL_RUN_DISPLAY_NAME, findSuite } from '../src/services/eval/suites.js';
import { evalPassRateGate } from '../src/services/judge/eval-rate.js';
import type { JudgeEvidence } from '../src/services/judge/types.js';

const GOOD: Record<string, string> = {
  slugify: `function slugify(input) {
  return String(input).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
module.exports = { slugify };`,
  chunk: `function chunk(list, size) {
  if (!Number.isInteger(size) || size <= 0) throw new Error('size must be a positive integer');
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
module.exports = { chunk };`,
  parse_kv: `function parseKV(input) {
  const out = {};
  for (const part of String(input).split(';')) {
    if (!part.trim()) continue;
    const at = part.indexOf('=');
    const key = (at === -1 ? part : part.slice(0, at)).trim();
    const value = at === -1 ? '' : part.slice(at + 1).trim();
    out[key] = value;
  }
  return out;
}
module.exports = { parseKV };`,
};

/** 只覆盖公开用例的补丁：两个公开样例硬编码，其余原样返回。 */
const OVERFIT: Record<string, string> = {
  slugify: `function slugify(input) {
  const s = String(input);
  if (s === 'Hello World') return 'hello-world';
  if (s === '  Hello   World  ') return 'hello-world';
  return s.replace(/\\s+/g, '-');
}
module.exports = { slugify };`,
};

function tmpRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'codelens-eval-'));
}

function writeImpl(root: string, suiteId: string, source: string): void {
  const suite = findSuite(suiteId)!;
  const abs = path.join(root, suite.implPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, source, 'utf8');
}

function evidence(toolNames: string[]): JudgeEvidence {
  return {
    sessionId: 's-eval',
    finishReason: 'stop',
    iteration: 1,
    tokenBudget: 100000,
    usage: { promptTokens: 10, completionTokens: 10 },
    toolCalls: toolNames.map((display_name) => ({ status: 'success', display_name })),
    approvals: [],
    circuitOpened: false,
  };
}

describe('固定评测套件', () => {
  it('三套件都有公开用例与隐藏用例', () => {
    expect(EVAL_SUITES).toHaveLength(3);
    for (const suite of EVAL_SUITES) {
      expect(suite.publicCases.length).toBeGreaterThan(0);
      expect(suite.hiddenCases.length).toBeGreaterThan(0);
    }
  });

  it('正确实现拿满分（判据可绿）', () => {
    const root = tmpRoot();
    for (const suite of EVAL_SUITES) writeImpl(root, suite.id, GOOD[suite.id]!);

    const battery = runEvalBattery(root, { includeHidden: true });
    expect(battery.total).toBeGreaterThan(0);
    expect(battery.passed).toBe(battery.total);
    expect(battery.score).toBe(1);
  });

  it('只针对公开用例打补丁 → 隐藏用例打红（判据可红）', () => {
    const root = tmpRoot();
    writeImpl(root, 'slugify', OVERFIT.slugify!);

    const suite = findSuite('slugify')!;
    const visible = runSuite(root, suite, false);
    const full = runSuite(root, suite, true);

    // 可见口径满分 —— 这正是 Agent 会看到的「假绿」。
    expect(visible.ok).toBe(true);
    // 全量口径必须红，否则隐藏集形同虚设。
    expect(full.ok).toBe(false);
    expect(full.passed).toBeLessThan(full.total);
    expect(full.passed / full.total).toBeLessThan(1);
  });

  it('实现文件缺失 / 导出不是函数时给出套件级错误而不是假绿', () => {
    const root = tmpRoot();
    const missing = runSuite(root, findSuite('chunk')!, true);
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('不存在');

    writeImpl(root, 'chunk', 'module.exports = { other: () => 1 };');
    const wrongExport = runSuite(root, findSuite('chunk')!, true);
    expect(wrongExport.ok).toBe(false);
    expect(wrongExport.error).toContain('不是函数');
  });

  it('deepEqual 跨 realm 认数组与普通对象', () => {
    expect(deepEqual([1, [2, 3]], [1, [2, 3]])).toBe(true);
    expect(deepEqual({ a: '1' }, { a: '1' })).toBe(true);
    expect(deepEqual({ a: '1' }, { a: 1 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});

describe('task.test_pass_rate 判据', () => {
  it('本轮没调用 eval.run → 不产出判据', () => {
    expect(evalPassRateGate(evidence(['读取文件', '写入文件']))).toBeNull();
  });

  it('调用过 eval.run → 产出可计分的判据', () => {
    const verdict = evalPassRateGate(evidence([EVAL_RUN_DISPLAY_NAME]));
    expect(verdict).not.toBeNull();
    expect(verdict!.criterion).toBe('task.test_pass_rate');
    expect(verdict!.status).not.toBe('unexec');
    expect(typeof verdict!.score).toBe('number');
  });
});
