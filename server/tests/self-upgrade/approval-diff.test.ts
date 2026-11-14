/**
 * 审批内 diff 判据（G3）：人在点「允许」之前必须看到具体会改哪些行。
 *
 * 这里钉死三条：
 * 1. create/overwrite/append/delete/replace 都能算出 diff，且增删行数与内容一致；
 * 2. 算不出来时返回空数组（预览失败不能阻断审批），而不是编一份假 diff；
 * 3. buildEffectPreview 真的把 diff 挂到 effect 上——只写 helper 不接线不算修好。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEffectPreview, buildWriteDiff } from '../../src/services/tools/effect-preview.js';
import type { ToolDefinition, RiskVerdict } from '../../src/types/tool.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'approval-diff-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): string {
  const abs = path.join(root, rel);
  writeFileSync(abs, content, 'utf8');
  return abs;
}

describe('buildWriteDiff：执行前就能看到行级变化', () => {
  it('create：新增内容进 + 行', () => {
    const abs = path.join(root, 'new.txt');
    const d = buildWriteDiff('create', { content: 'a\nb' }, abs, 'new.txt');
    expect(d).toHaveLength(1);
    expect(d[0]!.added).toBe(2);
    expect(d[0]!.removed).toBe(0);
    expect(d[0]!.preview).toContain('+a');
  });

  it('delete：被删内容进 - 行（用户在审批时看到会消失什么）', () => {
    const abs = writeFile('old.txt', 'x\ny\n');
    const d = buildWriteDiff('delete', {}, abs, 'old.txt');
    expect(d[0]!.removed).toBeGreaterThanOrEqual(2);
    expect(d[0]!.preview).toContain('-x');
  });

  it('replace：唯一命中时只显示一处替换', () => {
    const abs = writeFile('r.txt', 'hello world\n');
    const d = buildWriteDiff('replace', { oldText: 'world', newText: 'there' }, abs, 'r.txt');
    expect(d[0]!.added).toBe(1);
    expect(d[0]!.removed).toBe(1);
    expect(d[0]!.preview).toContain('+hello there');
  });

  it('replace 命中多处 → 不猜，返回空 diff', () => {
    const abs = writeFile('r2.txt', 'a\na\n');
    expect(buildWriteDiff('replace', { oldText: 'a', newText: 'b' }, abs, 'r2.txt')).toEqual([]);
  });

  it('overwrite 内容相同 → 空 diff（不制造假变化）', () => {
    const abs = writeFile('same.txt', 'same\n');
    expect(buildWriteDiff('overwrite', { content: 'same\n' }, abs, 'same.txt')).toEqual([]);
  });
});

describe('接线：buildEffectPreview 必须把 diff 挂到 effect 上', () => {
  const def = {
    name: 'fs.write',
    wireName: 'fs_write',
    displayName: '写文件',
    category: 'file',
    description: 'test',
    inputSchema: { type: 'object' },
    handler: async () => ({ ok: true, summary: '' }),
    timeoutMs: 1000,
    risk: 'high',
    approvalMode: 'hard',
    source: 'builtin',
    idempotent: false,
    maxResultChars: 1000,
    enabled: () => true,
  } as ToolDefinition;
  const verdict: RiskVerdict = { risk: 'high', approvalMode: 'hard' };

  it('删除已有文件：effect.diff 非空且路径正确', () => {
    writeFile('doomed.txt', 'one\ntwo\n');
    const effect = buildEffectPreview(def, { path: 'doomed.txt', operation: 'delete' }, { sandboxRoot: root }, verdict);
    expect(effect?.diff?.length).toBe(1);
    expect(effect?.diff?.[0]?.path).toBe('doomed.txt');
  });

  it('新建文件：effect.diff 直接可展示', () => {
    const effect = buildEffectPreview(
      def,
      { path: 'fresh.txt', operation: 'create', content: 'hi\n' },
      { sandboxRoot: root },
      verdict,
    );
    expect(effect?.diff?.[0]?.added).toBeGreaterThan(0);
  });
});
