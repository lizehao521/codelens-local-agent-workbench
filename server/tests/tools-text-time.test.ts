/**
 * Tests for text.diff (src/tools/builtin/text-diff.tool.ts)
 * and time.now (src/tools/builtin/time-now.tool.ts).
 *
 * Only the exports actually observed in the first 60 lines of each source file
 * are exercised: lineDiff / renderUnified for text.diff, timeNowTool for time.now.
 */

import { describe, expect, it } from 'vitest';

import { lineDiff, renderUnified } from '../src/tools/builtin/text-diff.tool.js';
import { timeNowTool } from '../src/tools/builtin/time-now.tool.js';

describe('text.diff — lineDiff', () => {
  it('marks unchanged lines as common and reports the single replacement', () => {
    const ops = lineDiff(['a', 'b', 'c'], ['a', 'x', 'c']);

    expect(ops.map((op) => op.type)).toEqual(['common', 'del', 'add', 'common']);
    expect(ops[0]).toEqual({ type: 'common', line: 'a' });
    expect(ops[1]).toEqual({ type: 'del', line: 'b' });
    expect(ops[2]).toEqual({ type: 'add', line: 'x' });
    expect(ops[3]).toEqual({ type: 'common', line: 'c' });
  });

  it('returns only common ops for identical inputs', () => {
    const ops = lineDiff(['same', 'lines'], ['same', 'lines']);

    expect(ops).toHaveLength(2);
    expect(ops.every((op) => op.type === 'common')).toBe(true);
    expect(ops.map((op) => op.line)).toEqual(['same', 'lines']);
  });

  it('emits pure deletions when the right side is empty', () => {
    const ops = lineDiff(['only', 'left'], []);

    expect(ops.map((op) => op.type)).toEqual(['del', 'del']);
    expect(ops.map((op) => op.line)).toEqual(['only', 'left']);
  });

  it('emits pure additions when the left side is empty', () => {
    const ops = lineDiff([], ['only', 'right']);

    expect(ops.map((op) => op.type)).toEqual(['add', 'add']);
    expect(ops.map((op) => op.line)).toEqual(['only', 'right']);
  });

  it('falls back to full replace when n * m exceeds the LCS guard (4_000_000)', () => {
    const left = Array.from({ length: 2001 }, (_, i) => `l${i}`);
    const right = Array.from({ length: 2001 }, (_, i) => `l${i}`);

    // 2001 * 2001 = 4_004_001 > 4_000_000 -> guard path, no common lines at all.
    const ops = lineDiff(left, right);

    expect(ops).toHaveLength(4002);
    expect(ops.some((op) => op.type === 'common')).toBe(false);
    expect(ops.slice(0, 2001).every((op) => op.type === 'del')).toBe(true);
    expect(ops.slice(2001).every((op) => op.type === 'add')).toBe(true);
  });
});

describe('text.diff — renderUnified', () => {
  it('counts additions and deletions and renders +/- markers', () => {
    const ops = lineDiff(['a', 'b', 'c'], ['a', 'x', 'c']);
    const rendered = renderUnified(ops, 1);

    expect(rendered.additions).toBe(1);
    expect(rendered.deletions).toBe(1);
    expect(rendered.text).toContain('-b');
    expect(rendered.text).toContain('+x');
    // contextLines = 1 keeps the neighbouring common line "a".
    expect(rendered.text).toContain(' a');
  });

  it('drops far-away common lines when contextLines is 0', () => {
    const ops = lineDiff(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'X', 'd', 'e']);
    const rendered = renderUnified(ops, 0);

    expect(rendered.additions).toBe(1);
    expect(rendered.deletions).toBe(1);
    expect(rendered.text).toContain('-c');
    expect(rendered.text).toContain('+X');
    expect(rendered.text).not.toContain(' a');
    expect(rendered.text).not.toContain(' e');
  });

  it('reports zero changes for identical inputs', () => {
    const rendered = renderUnified(lineDiff(['x', 'y'], ['x', 'y']), 3);

    expect(rendered.additions).toBe(0);
    expect(rendered.deletions).toBe(0);
    expect(rendered.text).not.toContain('+');
    expect(rendered.text).not.toContain('-');
  });
});

describe('time.now — tool definition', () => {
  it('exposes the expected metadata', () => {
    expect(timeNowTool.name).toBe('time.now');
    expect(timeNowTool.wireName).toBe('time_now');
    expect(timeNowTool.category).toBe('compute');
    expect(timeNowTool.risk).toBe('low');
    expect(timeNowTool.idempotent).toBe(true);
    expect(timeNowTool.enabled()).toBe(true);
    expect(timeNowTool.inputSchema.type).toBe('object');
    expect(Object.keys(timeNowTool.inputSchema.properties ?? {}).sort()).toEqual([
      'format',
      'from',
      'offsetDays',
      'timezone',
    ]);
  });
});

describe('time.now — handler', () => {
  it('formats a fixed UTC instant with the requested format', async () => {
    const result = await timeNowTool.handler({
      from: '2024-01-02T03:04:05.000Z',
      timezone: 'UTC',
      format: 'YYYY-MM-DD HH:mm:ss',
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).toContain('2024-01-02 03:04:05');
  });

  it('applies offsetDays on top of the from timestamp', async () => {
    const result = await timeNowTool.handler({
      from: '2024-01-01T00:00:00.000Z',
      timezone: 'UTC',
      offsetDays: 1,
      format: 'YYYY-MM-DD',
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).toContain('2024-01-02');
  });

  it('accepts GMT as an alias for UTC', async () => {
    const result = await timeNowTool.handler({
      from: '2024-06-15T12:00:00.000Z',
      timezone: 'GMT',
      format: 'YYYY-MM-DD',
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).toContain('2024-06-15');
  });

  it('rejects an unsupported timezone with TOOL_INVALID_ARGS', async () => {
    const result = await timeNowTool.handler({ timezone: 'Mars/Olympus' });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TOOL_INVALID_ARGS');
    expect(result.error?.kind).toBe('invalid_args');
    expect(result.summary).toContain('timezone');
  });

  it('rejects an unparsable from timestamp with TOOL_INVALID_ARGS', async () => {
    const result = await timeNowTool.handler({ from: 'not-a-date' });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TOOL_INVALID_ARGS');
    expect(result.summary).toContain('from');
  });

  it('rejects a non-finite offsetDays with TOOL_INVALID_ARGS', async () => {
    const result = await timeNowTool.handler({ offsetDays: Number.NaN });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TOOL_INVALID_ARGS');
    expect(result.summary).toContain('offsetDays');
  });
});
