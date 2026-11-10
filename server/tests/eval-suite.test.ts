/**
 * 代码修复任务族的判据自证（C3：每条判据都必须能被破坏夹具打红）。
 *
 * 这里验证三件事：
 *  1) 正确实现 → 全量用例满分（判据可以变绿）；
 *  2) 只满足公开用例 → 隐藏用例打红（防过拟合不是口号，是分数）；
 *  3) 本轮没跑过 eval.run → 不产出判据（不污染无关会话的覆盖率）。
 */

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runEvalBattery, runSuite, deepEqual } from '../src/services/eval/runner.js';
import { EVAL_SUITES, EVAL_RUN_DISPLAY_NAME, findSuite } from '../src/services/eval/suites.js';
import { evalPassRateGate } from '../src/services/judge/eval-rate.js';
import { hasScoredObjective } from '../src/services/rsi/manifest-builder.js';
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
  interval_merge: `function mergeIntervals(list) {
  const sorted = list
    .filter((x) => Array.isArray(x) && x.length === 2 && Number.isFinite(x[0]) && Number.isFinite(x[1]) && x[0] <= x[1])
    .slice()
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
module.exports = { mergeIntervals };`,
  parse_query: `function decode(raw) {
  const spaced = raw.replace(/\\+/g, ' ');
  try { return decodeURIComponent(spaced); } catch { return spaced; }
}
function parseQuery(input) {
  const text = String(input);
  const body = text.startsWith('?') ? text.slice(1) : text;
  const out = {};
  for (const part of body.split('&')) {
    if (!part) continue;
    const at = part.indexOf('=');
    const key = decode(at === -1 ? part : part.slice(0, at));
    const value = at === -1 ? '' : decode(part.slice(at + 1));
    out[key] = value;
  }
  return out;
}
module.exports = { parseQuery };`,
  to_roman: `function toRoman(n) {
  if (!Number.isInteger(n) || n < 1 || n > 3999) {
    throw new Error('n out of range: must be an integer in 1..3999');
  }
  const table = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let rest = n;
  let out = '';
  for (const [value, symbol] of table) {
    while (rest >= value) { out += symbol; rest -= value; }
  }
  return out;
}
module.exports = { toRoman };`,
  csv_import: `function parseCsv(input) {
  const text = String(input)
    .replace(/^\\uFEFF/, '')
    .replace(/\\r\\n/g, '\\n')
    .replace(/\\r/g, '\\n');

  const rows = [];
  const errors = [];
  let expected;
  let line = 1;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const startLine = line;
    const fields = [];
    let quoted = false;
    let cur = '';
    let quotedField = '';
    let inQuotes = false;
    let afterQuote = false;
    let syntaxError = '';
    let ended = false;

    while (i < n && !ended) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            quotedField += '"';
            i += 2;
          } else {
            inQuotes = false;
            afterQuote = true;
            i += 1;
          }
        } else if (ch === '\\n') {
          quotedField += '\\n';
          line += 1;
          i += 1;
        } else {
          quotedField += ch;
          i += 1;
        }
        continue;
      }
      if (afterQuote) {
        if (ch === ',') {
          fields.push(quotedField);
          quoted = true;
          afterQuote = false;
          i += 1;
        } else if (ch === '\\n') {
          fields.push(quotedField);
          quoted = true;
          afterQuote = false;
          i += 1;
          line += 1;
          ended = true;
        } else {
          syntaxError = '引号闭合后出现多余字符';
          while (i < n && text[i] !== '\\n') i += 1;
          if (i < n) {
            i += 1;
            line += 1;
          }
          ended = true;
        }
        continue;
      }
      if (ch === '"' && cur === '') {
        inQuotes = true;
        quotedField = '';
        i += 1;
        continue;
      }
      if (ch === ',') {
        fields.push(cur.trim());
        cur = '';
        i += 1;
        continue;
      }
      if (ch === '\\n') {
        fields.push(cur.trim());
        cur = '';
        i += 1;
        line += 1;
        ended = true;
        continue;
      }
      cur += ch;
      i += 1;
    }

    if (inQuotes) {
      errors.push({ line: startLine, message: '引号未闭合' });
      break;
    }
    if (syntaxError) {
      errors.push({ line: startLine, message: syntaxError });
      continue;
    }
    if (!ended) {
      if (afterQuote) {
        fields.push(quotedField);
        quoted = true;
      } else {
        fields.push(cur.trim());
      }
    }
    if (fields.length === 1 && !quoted && fields[0] === '') continue;
    if (expected === undefined) {
      expected = fields.length;
    } else if (fields.length !== expected) {
      errors.push({
        line: startLine,
        message: '列数不一致（期望 ' + expected + '，实际 ' + fields.length + '）',
      });
      continue;
    }
    rows.push(fields);
  }

  return { rows, errors };
}
module.exports = { parseCsv };`,
  json_patch: `function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function decodeToken(token) {
  if (/~(?![01])/.test(token)) throw new Error('非法路径转义');
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}
function parsePointer(pointer) {
  const p = String(pointer);
  if (p === '') return [];
  if (p[0] !== '/') throw new Error('非法路径');
  return p.slice(1).split('/').map(decodeToken);
}
function applyPatch(doc, ops) {
  let out = clone(doc);
  for (const op of Array.isArray(ops) ? ops : []) {
    const tokens = parsePointer(op.path);
    const isRoot = tokens.length === 0;
    if (isRoot) {
      if (op.op === 'add' || op.op === 'replace') { out = clone(op.value); continue; }
      throw new Error('不支持的操作');
    }
    const last = tokens[tokens.length - 1];
    let parent = out;
    for (let i = 0; i < tokens.length - 1; i += 1) {
      const key = tokens[i];
      if (parent === null || typeof parent !== 'object' || !(key in parent)) throw new Error('路径不存在');
      parent = parent[key];
    }
    if (op.op === 'add') {
      if (Array.isArray(parent)) {
        if (last === '-') { parent.push(clone(op.value)); continue; }
        if (!/^\\d+$/.test(last)) throw new Error('路径不存在');
        const idx = Number(last);
        if (idx > parent.length) throw new Error('数组下标越界');
        parent.splice(idx, 0, clone(op.value));
      } else {
        parent[last] = clone(op.value);
      }
      continue;
    }
    if (op.op === 'remove') {
      if (parent === null || typeof parent !== 'object' || !(last in parent)) throw new Error('路径不存在');
      if (Array.isArray(parent)) {
        if (!/^\\d+$/.test(last)) throw new Error('路径不存在');
        const idx = Number(last);
        if (idx >= parent.length) throw new Error('路径不存在');
        parent.splice(idx, 1);
      } else {
        delete parent[last];
      }
      continue;
    }
    if (op.op === 'replace') {
      if (parent === null || typeof parent !== 'object' || !(last in parent)) throw new Error('路径不存在');
      if (Array.isArray(parent)) {
        if (!/^\\d+$/.test(last)) throw new Error('路径不存在');
        const idx = Number(last);
        if (idx >= parent.length) throw new Error('路径不存在');
        parent[idx] = clone(op.value);
      } else {
        parent[last] = clone(op.value);
      }
      continue;
    }
    if (op.op === 'test') {
      if (!same(parent[last], op.value)) throw new Error('test 校验失败');
      continue;
    }
    throw new Error('不支持的操作');
  }
  return out;
}
module.exports = { applyPatch };`,
};

/** 多文件套件的参考实现：key 是套件目录内的相对路径。 */
const GOOD_FILES: Record<string, Record<string, string>> = {
  inventory_rollup: {
    'impl.cjs': `const { parseRow, isBlank } = require('./lib/parse.cjs');
const { round2, lineGross, applyTier } = require('./lib/pricing.cjs');

function rollup(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const merged = new Map();
  let skipped = 0;
  for (const line of list) {
    if (isBlank(line)) continue;
    const row = parseRow(line);
    if (!row) { skipped += 1; continue; }
    const cur = merged.get(row.sku);
    if (cur) { cur.qty += row.qty; cur.gross += lineGross(row); }
    else merged.set(row.sku, { qty: row.qty, gross: lineGross(row) });
  }
  const items = [...merged.entries()]
    .map(([sku, agg]) => ({ sku, qty: agg.qty, total: round2(applyTier(agg.qty, agg.gross)) }))
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  const total = round2(items.reduce((sum, it) => sum + it.total, 0));
  return { items, skipped, total };
}
module.exports = { rollup };`,
    'lib/parse.cjs': `function parseRow(line) {
  if (typeof line !== 'string') return null;
  const parts = line.split(',');
  if (parts.length < 3 || parts.length > 4) return null;
  const sku = parts[0].trim();
  const qtyRaw = parts[1].trim();
  const priceRaw = parts[2].trim();
  const discountRaw = parts.length === 4 ? parts[3].trim() : '0';
  if (!sku || !/^\\d+$/.test(qtyRaw) || priceRaw === '' || discountRaw === '') return null;
  const qty = Number(qtyRaw);
  const unitPrice = Number(priceRaw);
  const discount = Number(discountRaw);
  if (qty < 1) return null;
  if (!Number.isFinite(unitPrice) || unitPrice < 0) return null;
  if (!Number.isFinite(discount) || discount < 0 || discount > 1) return null;
  return { sku, qty, unitPrice, discount };
}
function isBlank(line) {
  return typeof line !== 'string' || line.trim() === '';
}
module.exports = { parseRow, isBlank };`,
    'lib/pricing.cjs': `function round2(x) {
  return Math.round(x * 100) / 100;
}
function lineGross(row) {
  return row.qty * row.unitPrice * (1 - row.discount);
}
function applyTier(qty, gross) {
  return qty >= 10 ? gross * 0.95 : gross;
}
module.exports = { round2, lineGross, applyTier };`,
  },
  job_queue: {
    'impl.cjs': `const { JobQueue } = require('./lib/queue.cjs');

function runQueue(ops) {
  const queue = new JobQueue();
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'add') queue.add(op.id, op.priority);
    else if (op.op === 'run') queue.run();
    else if (op.op === 'cancel') queue.cancel(op.id);
  }
  return { done: queue.done.slice(), pending: queue.snapshot() };
}
module.exports = { runQueue };`,
    'lib/queue.cjs': `class JobQueue {
  constructor() {
    this.items = [];
    this.done = [];
    this.seq = 0;
  }
  add(id, priority) {
    if (typeof id !== 'string' || id === '') return;
    const prio = Number.isInteger(priority) ? priority : 0;
    const existing = this.items.find((it) => it.id === id);
    if (existing) { existing.priority = prio; return; }
    this.items.push({ id, priority: prio, seq: this.seq++ });
  }
  run() {
    if (this.items.length === 0) return;
    let best = 0;
    for (let i = 1; i < this.items.length; i += 1) {
      const a = this.items[i];
      const b = this.items[best];
      if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
    }
    this.done.push(this.items[best].id);
    this.items.splice(best, 1);
  }
  cancel(id) {
    this.items = this.items.filter((it) => it.id !== id);
  }
  snapshot() {
    return this.items
      .slice()
      .sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq))
      .map((it) => ({ id: it.id, priority: it.priority }));
  }
}
module.exports = { JobQueue };`,
  },
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

/** 写多文件套件：路径相对套件目录。 */
function writeSuiteFiles(root: string, suiteId: string, files: Record<string, string>): void {
  const suite = findSuite(suiteId)!;
  const suiteDir = path.dirname(path.join(root, suite.implPath));
  for (const [rel, source] of Object.entries(files)) {
    const abs = path.join(suiteDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, source, 'utf8');
  }
}

const FIXTURES_DIR = fileURLToPath(new URL('../eval-fixtures', import.meta.url));

/**
 * 递归复制夹具目录。
 * 不用 node:fs 的 cpSync：当前 Node 构建在 Windows 上调用它会原生崩溃（0xC0000005），
 * 手动复制两个目录足够，且行为可预期。
 */
function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else writeFileSync(dst, readFileSync(src));
  }
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
  it('十套件都有公开用例与隐藏用例', () => {
    expect(EVAL_SUITES).toHaveLength(10);
    for (const suite of EVAL_SUITES) {
      expect(suite.publicCases.length).toBeGreaterThan(0);
      expect(suite.hiddenCases.length).toBeGreaterThan(0);
    }
  });

  it('正确实现拿满分（判据可绿）', () => {
    const root = tmpRoot();
    for (const suite of EVAL_SUITES) {
      const files = GOOD_FILES[suite.id];
      if (files) writeSuiteFiles(root, suite.id, files);
      else writeImpl(root, suite.id, GOOD[suite.id]!);
    }

    const battery = runEvalBattery(root, { includeHidden: true });
    expect(battery.total).toBeGreaterThan(0);
    expect(battery.passed).toBe(battery.total);
    expect(battery.score).toBe(1);
  });

  it('版本库里的缺陷夹具在隐藏口径下真红（缺陷真红）', () => {
    const fixtureBacked = ['csv_import', 'json_patch', ...Object.keys(GOOD_FILES)];
    for (const id of fixtureBacked) {
      const suite = findSuite(id)!;
      const root = tmpRoot();
      copyDir(
        path.join(FIXTURES_DIR, id),
        path.dirname(path.join(root, suite.implPath)),
      );

      const full = runSuite(root, suite, true);
      expect(full.error).toBeUndefined();
      expect(full.ok).toBe(false);
      // 缺陷必须能被隐藏用例抓住：只有公开用例红说明隐藏集没起作用。
      expect(full.failures.some((f) => f.hidden)).toBe(true);
    }
  });

  it('多文件套件只允许 require files 白名单内的相对路径', () => {
    const suite = findSuite('inventory_rollup')!;

    for (const badSpec of ['./lib/secret.cjs', 'fs']) {
      const root = tmpRoot();
      writeSuiteFiles(root, 'inventory_rollup', {
        'impl.cjs': `const s = require(${JSON.stringify(badSpec)});\nmodule.exports = { rollup: () => s };`,
        'lib/secret.cjs': 'module.exports = { secret: true };',
      });
      const full = runSuite(root, suite, true);
      expect(full.ok).toBe(false);
      expect(full.error).toContain(badSpec === 'fs' ? '相对路径' : '白名单');
    }
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

describe('hasScoredObjective', () => {
  const v = (criterion: string, score?: number) => ({
    layer: 'L1' as const,
    criterion,
    status: 'fail' as const,
    ...(score === undefined ? {} : { score }),
  });

  it('任意 objective 有分即为可测（不只认语义判据）', () => {
    expect(hasScoredObjective([v('task.test_pass_rate', 0.644)])).toBe(true);
    expect(hasScoredObjective([v('tool.capability.reuse', 0.5)])).toBe(true);
  });

  it('护栏有分不算目标读数', () => {
    expect(hasScoredObjective([v('tool.discipline.lesson_pairing', 1)])).toBe(false);
    expect(hasScoredObjective([v('tool.success_rate', 1)])).toBe(false);
  });

  it('目标判据没有数值（unexec/absent）不算', () => {
    expect(hasScoredObjective([v('task.test_pass_rate')])).toBe(false);
    expect(hasScoredObjective([])).toBe(false);
  });
});
