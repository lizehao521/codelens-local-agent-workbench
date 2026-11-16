import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadExemplars,
  parseExemplars,
  renderExemplarBlock,
  selectExemplars,
  type ExemplarRecord,
} from '../../src/services/agent/exemplar-injection.js';
import { buildRuntimeSections, buildWorkspaceSection } from '../../src/services/agent/system-prompt.js';

const rec = (i: number, over: Partial<ExemplarRecord> = {}): ExemplarRecord => ({
  id: `e${i}`,
  title: `缺陷 ${i}`,
  gapType: 'defect',
  targetFile: 'src/tools/x.ts',
  observable: `行为 ${i} 应被拒绝`,
  passed: [`judge green ${i}/1`],
  at: `2026-11-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
  ...over,
});

describe('memory exemplar injection', () => {
  it('只选正例：passed 非空、title/observable 有效，并按 at 新到旧', () => {
    const records = [
      rec(1),
      rec(2, { at: '2026-11-20T00:00:00.000Z' }),
      rec(3, { passed: [] }),
      rec(4, { title: ' ' }),
    ];
    const selected = selectExemplars(records, { maxItems: 0, maxChars: 0 });
    expect(selected.selected.map((r) => r.id)).toEqual(['e2', 'e1']);
    expect(selected.evicted).toEqual([]);
    expect(selected.overflow).toBe(false);
  });

  it('条数预算会保留前缀，其余进入 evicted', () => {
    const result = selectExemplars([rec(1), rec(2), rec(3)], { maxItems: 2, maxChars: 0 });
    expect(result.selected.map((r) => r.id)).toEqual(['e3', 'e2']);
    expect(result.evicted.map((r) => r.id)).toEqual(['e1']);
    expect(result.overflow).toBe(true);
    expect(result.overflow).not.toBe(false);
  });

  it('字符预算会停止注入，但首条例外始终保留', () => {
    const result = selectExemplars([rec(1), rec(2)], { maxItems: 0, maxChars: 1 });
    expect(result.selected.map((r) => r.id)).toEqual(['e2']);
    expect(result.evicted.map((r) => r.id)).toEqual(['e1']);
    expect(result.chars).toBeGreaterThan(1);
  });

  it('id 重复与标题/observable 近似的 exemplar 只保留一条', () => {
    const base = rec(1, { title: '删除目录缺少 recursive 校验', observable: '不传 recursive 应返回 invalid_args' });
    const exact = { ...base, id: 'e2' };
    const near = rec(3, { title: '删除目录缺少 recursive 校验参数', observable: '不传 recursive 时应返回 invalid_args' });
    const result = selectExemplars([base, exact, near], { maxItems: 0, maxChars: 0 });
    expect(result.selected).toHaveLength(1);
  });

  it('JSONL 解析跳过无断言/非法行并计数', () => {
    const text = [
      JSON.stringify(rec(1)),
      JSON.stringify({ ...rec(2), passed: [] }),
      '{bad json',
      '',
    ].join('\n');
    const parsed = parseExemplars(text);
    expect(parsed.records.map((r) => r.id)).toEqual(['e1']);
    expect(parsed.invalidLines).toBe(2);
  });

  it('渲染块只包含选中的正例，空选择不产生段落', () => {
    const block = renderExemplarBlock(selectExemplars([rec(1)], { maxItems: 0, maxChars: 0 }));
    expect(block).toContain('【可复用正例');
    expect(block).toContain('[e1]');
    expect(renderExemplarBlock(selectExemplars([], { maxItems: 0, maxChars: 0 }))).toBe('');
    expect(selectExemplars([], { maxItems: 0, maxChars: 0 }).overflow).toBe(false);
    expect(selectExemplars([], { maxItems: 0, maxChars: 0 }).selected.length > 0).toBe(false);
  });

  it('生产合成器把 exemplars 正例接进 buildRuntimeSections', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'exemplar-prompt-'));
    const file = path.join(root, 'exemplars.jsonl');
    try {
      writeFileSync(file, JSON.stringify(rec(1, { title: '已知正例进入提示词', observable: '必须出现这条正例' })) + '\n', 'utf8');
      const section = buildRuntimeSections(root, file);
      expect(section.startsWith(buildWorkspaceSection(root))).toBe(true);
      expect(section).toContain('【可复用正例');
      expect(section).toContain('已知正例进入提示词');
      expect(buildRuntimeSections(root, path.join(root, 'missing.jsonl'))).not.toContain('【可复用正例');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
