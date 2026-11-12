import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendRejection,
  authorFailures,
  formatRejections,
  isExhausted,
  readRejections,
  type Rejection,
} from '../scripts/lib/agent-feedback.js';

const mk = (over: Partial<Rejection> = {}): Rejection => ({
  id: 'some-gap',
  stage: 'author-compile',
  code: 'TS2339',
  detail: "Property 'matches' does not exist on type '{ code: string }'",
  fix: '只用契约里已列出的字段',
  at: '2026-11-12T00:00:00.000Z',
  ...over,
});

describe('formatRejections', () => {
  it('空账本时明确告知这是第一轮，而不是留空', () => {
    const s = formatRejections([]);
    expect(s).toContain('暂无被拒记录');
  });

  it('把 stage / code / id / 具体证据 / 改法 全部带出来', () => {
    const s = formatRejections([mk()]);
    expect(s).toContain('[author-compile/TS2339]');
    expect(s).toContain('some-gap');
    expect(s).toContain("Property 'matches' does not exist");
    expect(s).toContain('必须这样改：');
    expect(s).toContain('只用契约里已列出的字段');
  });

  it('只取最近 limit 条，且按时间顺序编号', () => {
    const list = [mk({ id: 'a' }), mk({ id: 'b' }), mk({ id: 'c' })];
    const s = formatRejections(list, 2);
    expect(s).not.toContain('a：');
    expect(s).toContain('1. [author-compile/TS2339] b：');
    expect(s).toContain('2. [author-compile/TS2339] c：');
  });

  it('超长证据被截断，不会把提示词撑爆', () => {
    const s = formatRejections([mk({ detail: 'x'.repeat(1000) })], 1);
    expect(s.length).toBeLessThan(600);
  });
});

describe('拒绝账本读写', () => {
  it('append 后能读回，且保留具体证据（这是「反馈明确」的底线）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rsi-fb-'));
    const file = path.join(dir, 'r.jsonl');
    try {
      appendRejection(mk(), file);
      const back = readRejections(5, file);
      expect(back).toHaveLength(1);
      expect(back[0]!.code).toBe('TS2339');
      expect(back[0]!.detail).toContain('matches');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('坏行被跳过，不影响后续读取', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rsi-fb-'));
    const file = path.join(dir, 'r.jsonl');
    try {
      writeFileSync(file, 'not json\n{"id":"ok","stage":"propose","code":"X","detail":"d","fix":"f"}\n', 'utf8');
      const back = readRejections(5, file);
      expect(back).toHaveLength(1);
      expect(back[0]!.id).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('账本不存在时返回空数组，而不是抛错', () => {
    expect(readRejections(3, path.join(tmpdir(), 'definitely-missing-rsi.jsonl'))).toEqual([]);
  });
});

describe('死题淘汰', () => {
  const withLedger = (rows: Rejection[], fn: (file: string) => void) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rsi-ex-'));
    const file = path.join(dir, 'r.jsonl');
    try {
      for (const r of rows) appendRejection(r, file);
      fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('只统计出题阶段的失败，采纳阶段的不算', () => {
    withLedger(
      [
        mk({ id: 'x', stage: 'author-baseline', code: 'GREEN_BASELINE' }),
        mk({ id: 'x', stage: 'adopt-a2', code: 'A2_5_PROBE_INVALID' }),
      ],
      (file) => expect(authorFailures('x', file)).toBe(1),
    );
  });

  it('不同 id 的失败不互相牵连', () => {
    withLedger(
      [mk({ id: 'a', stage: 'author-baseline' }), mk({ id: 'b', stage: 'author-compile' })],
      (file) => {
        expect(authorFailures('a', file)).toBe(1);
        expect(authorFailures('b', file)).toBe(1);
      },
    );
  });

  it('失败 2 次判为死题（作废后候选被删，幂等检查拦不住它，必须靠这个）', () => {
    withLedger(
      [
        mk({ id: 'dead', stage: 'author-baseline', code: 'GREEN_BASELINE' }),
        mk({ id: 'dead', stage: 'author-compile', code: 'TS2339' }),
      ],
      (file) => expect(isExhausted('dead', 2, file)).toBe(true),
    );
  });

  it('只失败 1 次还不算死题，仍有重出机会', () => {
    withLedger([mk({ id: 'once', stage: 'author-baseline' })], (file) =>
      expect(isExhausted('once', 2, file)).toBe(false),
    );
  });
});
