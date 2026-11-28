import { describe, expect, it } from 'vitest';
import { fsWriteTool } from '../src/tools/builtin/fs-write.tool.js';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * D1-B-08 判据：fs.write replace 在混合换行文件上必须逐片段匹配原文，
 * 不得因全文任一处含 CRLF 就把 oldText 的所有 LF 强转 CRLF。
 *
 * 红队 B 报 medium；督导独立探针证实：
 *   原文 `head\r\nline1\nline2\ntail\r\n`（前段 CRLF、中段 LF），
 *   replace 中段 LF 片段 `line1\nline2` → REPLACE_NO_MATCH（真缺陷）。
 *
 * 本判据双向钉死：
 *   - 混合换行下 replace LF 片段成功（抓真缺陷，当前实现 FAIL）
 *   - 纯 CRLF / 纯 LF 场景回归保护（修复不得破坏既有行为）
 *   - 混合换行下 replace CRLF 片段也成功
 */
const ROOT = process.cwd();
const ctx = {
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: ROOT,
  signal: new AbortController().signal,
  reportProgress: () => {},
};

async function replaceOn(initial: string, oldText: string, newText: string) {
  const file = `probe-mixed-eol-${Math.random().toString(36).slice(2)}.txt`;
  const abs = path.join(ROOT, file);
  writeFileSync(abs, initial, 'utf8');
  try {
    const r = await fsWriteTool.handler!(
      { path: file, operation: 'replace', oldText, newText },
      ctx,
    );
    const content = readFileSync(abs, 'utf8');
    return { ok: r.ok, code: r.error?.code ?? null, content };
  } finally {
    rmSync(abs, { force: true });
  }
}

describe('D1-B-08：fs.write replace 混合换行', () => {
  it('混合换行文件：replace 一个 LF 片段应成功', async () => {
    const r = await replaceOn('head\r\nline1\nline2\ntail\r\n', 'line1\nline2', 'LINE1\nLINE2');
    expect(r.ok, `code=${r.code}`).toBe(true);
    expect(r.content).toContain('LINE1\nLINE2');
    expect(r.content).toContain('head\r\n'); // CRLF 段保持
    expect(r.content).toContain('tail\r\n');
  });

  it('混合换行文件：replace 一个 CRLF 片段应成功', async () => {
    const r = await replaceOn('head\r\nline1\r\nline2\ntail\n', 'head\r\nline1', 'HEAD\r\nLINE1');
    expect(r.ok, `code=${r.code}`).toBe(true);
    expect(r.content).toContain('HEAD\r\nLINE1');
  });

  it('纯 LF 文件：replace 行为不回归', async () => {
    const r = await replaceOn('a\nb\nc\n', 'b', 'B');
    expect(r.ok, `code=${r.code}`).toBe(true);
    expect(r.content).toBe('a\nB\nc\n');
  });

  it('纯 CRLF 文件：replace 行为不回归', async () => {
    const r = await replaceOn('a\r\nb\r\nc\r\n', 'b', 'B');
    expect(r.ok, `code=${r.code}`).toBe(true);
    expect(r.content).toContain('B');
  });

  it('多块同文不同换行：原样 oldText 必须替换原样命中的那一块（不得错位到 legacy 形态块）', async () => {
    // 原文含三段内容相同、换行风格不同的块；oldText 原样精确等于第一块。
    const initial = 'a\nb\r\nc' + '\n' + 'a\r\nb\r\nc\r\n' + '\n' + 'a\nb\nc';
    const r = await replaceOn(initial, 'a\nb\r\nc', 'REPLACED');
    expect(r.ok, `code=${r.code}`).toBe(true);
    expect(r.content.startsWith('REPLACED')).toBe(true); // 必须替换索引0的原样块
    expect(r.content).toContain('a\r\nb\r\nc\r\n'); // 第二块保持不动
  });

  it('原样 oldText 命中多处时不得被归一化候选的单次命中错位替换（应报歧义）', async () => {
    // 原样 'a\nb\nc' 命中 2 处 LF 块；归一化全CRLF候选只命中 1 处 CRLF 块。
    const initial = 'prefix\n' + 'a\nb\nc' + '\nmiddle\n' + 'a\nb\nc' + '\nsuffix\n' + 'a\r\nb\r\nc';
    const r = await replaceOn(initial, 'a\nb\nc', 'REPLACED');
    expect(r.ok, `code=${r.code}`).toBe(false);
    expect(r.code).toBe('REPLACE_AMBIGUOUS'); // 原样2处=歧义，不得静默替换 CRLF 块
    expect((r.content.match(/a\nb\nc/g) || []).length).toBe(2); // LF 块保持不动
  });
});
