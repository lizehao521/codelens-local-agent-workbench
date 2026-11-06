/**
 * Unit tests for ContextManager (perf-report H-P2 recommended coverage).
 *
 * Focus: (1) the pure `rowsToUpstreamMessages` pairing, (2) the >75% occupancy
 * trigger firing compaction, and critically (3) the fail-closed contract —
 * when the nine-section fidelity check fails, `buildView` must surface
 * `compactionFailed` and NOT silently ship the over-window transcript
 * upstream (AC-09). A success path is also covered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextManager, rowsToUpstreamMessages, COMPACTION_THRESHOLD, TAIL_TURNS } from './context-manager.service.js';
import type { MessageRow } from '../memory/message.repository.js';

function row(seq: number, role: MessageRow['role'], content: string, extra: Partial<MessageRow> = {}): MessageRow {
  return {
    id: `m${seq}`,
    session_id: 's1',
    seq,
    role,
    content,
    segments_json: null,
    reasoning_content: null,
    tool_calls_json: null,
    tool_call_id: null,
    finish_reason: null,
    usage_json: null,
    tokens: 0,
    is_summary: 0,
    created_at: seq,
    ...extra,
  };
}

function manyRows(n: number): MessageRow[] {
  const out: MessageRow[] = [];
  for (let i = 1; i <= n; i += 1) {
    out.push(row(i, i % 2 === 1 ? 'user' : 'assistant', `这是第 ${i} 条较长的会话内容，用于撑满上下文窗口以触发压缩逻辑。`));
  }
  return out;
}

const NINE_SECTION_SUMMARY = [
  '任务目标：完成演示',
  '关键决策：采用压缩方案',
  '已执行工具及结果：无',
  '用户偏好与约束：中文',
  '未解决问题：无',
  '重要文件路径：无',
  '错误与恢复：无',
  '当前状态：进行中',
  '下一步计划：继续',
].join('\n');

describe('context-manager · constants', () => {
  it('compaction threshold is 75% (H-P2)', () => {
    expect(COMPACTION_THRESHOLD).toBe(0.75);
  });
  it('tail retention keeps the last 6 turns', () => {
    expect(TAIL_TURNS).toBe(6);
  });
});

describe('context-manager · rowsToUpstreamMessages (pure pairing)', () => {
  it('maps user/system rows verbatim', () => {
    const out = rowsToUpstreamMessages([row(1, 'user', 'hi'), row(2, 'system', 'sys')]);
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'sys' },
    ]);
  });

  it('carries tool_calls on assistant rows', () => {
    const out = rowsToUpstreamMessages([row(1, 'assistant', 'ok', { tool_calls_json: '[{"id":"c1"}]' })]);
    expect(out[0]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1' }] });
  });

  it('carries tool_call_id on tool rows (else upstream 400s)', () => {
    const out = rowsToUpstreamMessages([row(1, 'tool', 'result', { tool_call_id: 'c1' })]);
    expect(out[0]).toMatchObject({ role: 'tool', content: 'result', tool_call_id: 'c1' });
  });

  it('omits empty tool_call_id on tool rows', () => {
    const out = rowsToUpstreamMessages([row(1, 'tool', 'result', { tool_call_id: null })]);
    expect(out[0]).not.toHaveProperty('tool_call_id');
  });
});

describe('context-manager · buildView fail-closed on fidelity failure (H-P2)', () => {
  let deps: any;
  beforeEach(() => {
    deps = {
      messages: { listBySession: vi.fn(() => manyRows(30)), insertAt: vi.fn() },
      resolveContextWindow: vi.fn(() => 30), // tiny window → occupancy >> 75%
      sse: { emit: vi.fn() },
      // degenerate summary: no section headings → fidelity fails
      summarize: vi.fn(async () => '只是随便写了一段话，没有任何九段式小标题。'),
    };
  });

  it('triggers compaction and reports compactionFailed (no silent truncation)', async () => {
    const cm = new ContextManager(deps);
    const view = await cm.buildView('s1', 'p', 'm', 'sys');
    expect(view.compactionFailed).toBeDefined();
    expect(view.compactionFailed!.length).toBeGreaterThan(0);
    expect(view.compacted).toBe(false);
    expect(deps.sse.emit).toHaveBeenCalledWith(
      'context_notice',
      expect.objectContaining({ reason: 'compaction_failed' }),
    );
    // success path's persist must NOT have run
    expect(deps.messages.insertAt).not.toHaveBeenCalled();
  });
});

describe('context-manager · buildView success path', () => {
  let deps: any;
  beforeEach(() => {
    deps = {
      messages: { listBySession: vi.fn(() => manyRows(30)), insertAt: vi.fn() },
      resolveContextWindow: vi.fn(() => 30),
      sse: { emit: vi.fn() },
      summarize: vi.fn(async () => NINE_SECTION_SUMMARY),
    };
  });

  it('compacts and anchors when the summary passes fidelity', async () => {
    const cm = new ContextManager(deps);
    const view = await cm.buildView('s1', 'p', 'm', 'sys');
    expect(view.compacted).toBe(true);
    expect(view.compactionFailed).toBeUndefined();
    // a summary anchor was persisted at the compaction boundary
    expect(deps.messages.insertAt).toHaveBeenCalledTimes(1);
    expect(deps.sse.emit).toHaveBeenCalledWith(
      'context_notice',
      expect.objectContaining({ reason: 'compacted' }),
    );
  });
});

describe('context-manager · buildView no compaction when occupancy is low', () => {
  it('does not compact a short conversation', async () => {
    const deps: any = {
      messages: { listBySession: vi.fn(() => [row(1, 'user', 'hi')]), insertAt: vi.fn() },
      resolveContextWindow: vi.fn(() => 200_000), // huge window → never crosses 75%
      sse: { emit: vi.fn() },
      summarize: vi.fn(async () => NINE_SECTION_SUMMARY),
    };
    const cm = new ContextManager(deps);
    const view = await cm.buildView('s1', 'p', 'm', 'sys');
    expect(view.compacted).toBe(false);
    expect(view.compactionFailed).toBeUndefined();
    expect(deps.summarize).not.toHaveBeenCalled();
  });
});
