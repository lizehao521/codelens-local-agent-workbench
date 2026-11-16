import { describe, expect, it } from 'vitest';
import type { RsiIterationRecord } from '../src/services/api';
import {
  criteriaCounts,
  decisionLabel,
  decisionTone,
  extractSearchEvidence,
  rawChanges,
  rawHighlights,
  verdictTone,
} from '../src/lib/rsi-live';

function rec(patch: Partial<RsiIterationRecord> & { raw?: Record<string, unknown> } = {}): RsiIterationRecord {
  return {
    id: 'x',
    task: 'task',
    at: '2026-11-14T00:00:00.000Z',
    attempt: 1,
    verdict: 'improved',
    domain: 'D1',
    trigger: 'manual',
    version: '2.21.0',
    raw: {},
    result: {
      decision: 'continue',
      headline: '',
      criteria: [],
      rollbackReasons: [],
      confidence: 0.8,
    },
    ...patch,
  } as RsiIterationRecord;
}

describe('rsi-live 展示逻辑', () => {
  it('决策标签与 tone 覆盖回滚/停止', () => {
    expect(decisionLabel('rollback')).toBe('回滚');
    expect(decisionTone('halt')).toBe('danger');
    expect(decisionTone('continue')).toBe('success');
    expect(verdictTone('not_improved')).toBe('danger');
  });

  it('统计判据 pass/fail/unexec', () => {
    const item = rec({
      result: {
        decision: 'retry',
        headline: '',
        rollbackReasons: [],
        confidence: 0.5,
        criteria: [
          { id: 'c1', name: 'a', threshold: '1', actual: '1', status: 'pass', onFail: null },
          { id: 'c2', name: 'b', threshold: '1', actual: '0', status: 'fail', onFail: 'retry' },
          { id: 'c3', name: 'c', threshold: '1', actual: '—', status: 'unexec', onFail: null },
        ],
      },
    });
    expect(criteriaCounts(item)).toEqual({ pass: 1, fail: 1, unexec: 1 });
  });

  it('逐轮 raw 字段变化只显示差异', () => {
    const prev = rec({ raw: { version: '2.20.0', strategy: 'a', stable: 'same' } });
    const cur = rec({ raw: { version: '2.21.0', strategy: 'b', stable: 'same' } });
    expect(rawChanges(prev, cur)).toEqual([
      { key: 'version', from: '2.20.0', to: '2.21.0' },
      { key: 'strategy', from: 'a', to: 'b' },
    ]);
  });

  it('提取联网检索证据，不把普通字段当证据', () => {
    const evidence = extractSearchEvidence({
      searchResults: ['competitor A: 90%', 'competitor B: 82%'],
      judge: 'tests/x.test.ts',
      note: 'not evidence',
    });
    expect(evidence).toEqual([
      { key: 'searchResults[0]', text: 'competitor A: 90%' },
      { key: 'searchResults[1]', text: 'competitor B: 82%' },
    ]);
  });

  it('参数/信号高亮只取相关键', () => {
    const rows = rawHighlights({ signals: 'threshold+', model: 'm', budget: '12/12', random: 1 });
    expect(rows.map((r) => r.key)).toEqual(['signals', 'model', 'budget']);
  });
});
