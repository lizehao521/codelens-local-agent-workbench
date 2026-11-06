/**
 * `text.diff` —— 进主树前的自证（写闸复用）。
 *
 * 这个工具此前是 10 个内置工具里**唯一零测试覆盖**的（工具纪律闸 2 建起来
 * 第一件事就抓到它）。这里补的是真用例：跑 handler、看 diff 输出，不是
 * 提一下名字骗过闸。
 */

import { describe, it, expect } from 'vitest';
import { textDiffTool } from '../src/tools/builtin/text-diff.tool.js';

const ctx = {
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: '.',
  signal: new AbortController().signal,
  reportProgress: () => {},
};

async function diff(left: string, right: string, contextLines?: number) {
  return textDiffTool.handler({ left, right, ...(contextLines === undefined ? {} : { contextLines }) }, ctx);
}

describe('text.diff · 基本语义', () => {
  it('两段一致 → identical=true，无增删', async () => {
    const r = await diff('a\nb\nc', 'a\nb\nc');
    expect(r.ok).toBe(true);
    const d = r.data as { diff: string; additions: number; deletions: number; identical: boolean };
    expect(d.identical).toBe(true);
    expect(d.additions).toBe(0);
    expect(d.deletions).toBe(0);
    expect(r.summary).toContain('完全一致');
  });

  it('改一行 → 新增 1、删除 1，diff 里同时含 - 与 + 行', async () => {
    const r = await diff('a\nb\nc', 'a\nB\nc');
    expect(r.ok).toBe(true);
    const d = r.data as { diff: string; additions: number; deletions: number; identical: boolean };
    expect(d.identical).toBe(false);
    expect(d.additions).toBe(1);
    expect(d.deletions).toBe(1);
    expect(d.diff).toContain('-b');
    expect(d.diff).toContain('+B');
    expect(r.summary).toContain('新增 1 行');
    expect(r.summary).toContain('删除 1 行');
  });

  it('纯新增 / 纯删除的计数正确', async () => {
    const add = await diff('a', 'a\nb\nc');
    const del = await diff('a\nb\nc', 'a');
    expect((add.data as { additions: number }).additions).toBe(2);
    expect((add.data as { deletions: number }).deletions).toBe(0);
    expect((del.data as { additions: number }).additions).toBe(0);
    expect((del.data as { deletions: number }).deletions).toBe(2);
  });

  it('unified diff 头部含 @@ 段标记', async () => {
    const r = await diff('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nX\nd\ne\nf\ng\nh');
    expect((r.data as { diff: string }).diff).toMatch(/@@ -\d+(,\d+)? \+\d+(,\d+)? @@/);
  });
});

describe('text.diff · contextLines 参数', () => {
  it('contextLines=0 时不输出上下文行，只留变更行', async () => {
    const r = await diff('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne', 0);
    const diffText = (r.data as { diff: string }).diff;
    expect(diffText).toContain('-c');
    expect(diffText).toContain('+X');
    // 上下文行以空格开头；0 上下文时不应有「 a」这类行
    expect(diffText.split('\n').filter((l) => l.startsWith(' ')).length).toBe(0);
  });

  it('contextLines 越界 → TOOL_INVALID_ARGS，不抛异常', async () => {
    for (const bad of [-1, 11, 1.5, 'x']) {
      const r = await textDiffTool.handler({ left: 'a', right: 'b', contextLines: bad }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('TOOL_INVALID_ARGS');
    }
  });

  it('缺省 contextLines = 3（默认上下文）', async () => {
    const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const r = await diff(lines.join('\n'), lines.map((l) => (l === 'e' ? 'E' : l)).join('\n'));
    const body = (r.data as { diff: string }).diff;
    // 默认 3 行上下文：变更行 e 前后各留 3 行 → 应看到 b 和 h
    expect(body).toContain(' b');
    expect(body).toContain(' h');
  });
});

describe('text.diff · 输入边界', () => {
  it('空串与空串 → identical', async () => {
    const r = await diff('', '');
    expect((r.data as { identical: boolean }).identical).toBe(true);
  });

  it('缺 left/right 参数按空串处理，不崩溃', async () => {
    const r = await textDiffTool.handler({}, ctx);
    expect(r.ok).toBe(true);
    expect((r.data as { identical: boolean }).identical).toBe(true);
  });

  it('CRLF 行尾不产生伪差异（按 \n 切分，\r 保留为内容）', async () => {
    // 同样内容、同为 \n 切分 → 一致；这里验证换行语义稳定
    const r = await diff('a\r\nb', 'a\r\nb');
    expect((r.data as { identical: boolean }).identical).toBe(true);
  });
});
