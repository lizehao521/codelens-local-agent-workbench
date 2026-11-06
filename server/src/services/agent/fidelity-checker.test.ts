/**
 * Unit tests for fidelity-checker (perf-report H-P2 recommended coverage).
 *
 * The nine-section mechanical self-check is what keeps L2 compression honest:
 * a summary that dropped a section's content must FAIL, so the loop falls back
 * to the "context full" path instead of silently shipping a truncated view.
 * Covers the line-heading match (P2-2 cheat vector), the evidence floors, and
 * the compaction prompt contract.
 */

import { describe, it, expect } from 'vitest';
import {
  SUMMARY_SECTIONS,
  checkFidelity,
  checkEvidencePreservation,
  buildCompactionPrompt,
} from './fidelity-checker.js';

const OK_SUMMARY = SUMMARY_SECTIONS.map((s) => `${s}：示例内容`).join('\n');

describe('fidelity-checker · nine-section presence', () => {
  it('passes when all nine sections head their own lines', () => {
    const r = checkFidelity(OK_SUMMARY);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.present).toHaveLength(9);
  });

  it('detects missing sections', () => {
    const partial = ['任务目标：x', '关键决策：y', '当前状态：z'].join('\n');
    const r = checkFidelity(partial);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('已执行工具及结果');
    expect(r.missing).toContain('下一步计划');
  });

  it('P2-2 cheat vector: a section name mid-sentence does NOT count', () => {
    // "任务目标" appears but does not HEAD a line → must be reported missing.
    const cheat = '我们刚才讨论了任务目标，但并没有真正写出这一节。\n关键决策：有';
    const r = checkFidelity(cheat);
    expect(r.missing).toContain('任务目标');
    expect(r.present).toContain('关键决策');
  });

  it('accepts markdown / 【】 decorated headings', () => {
    const decorated = SUMMARY_SECTIONS.map((s, i) => `${i === 0 ? '## ' : '【'}${s}${i === 0 ? '' : '】'}：x`).join('\n');
    const r = checkFidelity(decorated);
    expect(r.ok).toBe(true);
  });
});

describe('fidelity-checker · evidence floors (P2-2)', () => {
  const transcriptWithPath = 'edit src/foo/bar.ts then run ./build.sh, result 12345';
  const transcriptWithNumbers = 'measured 123, then 456, finally 789 units';

  it('flags dropped file-path evidence', () => {
    const r = checkEvidencePreservation('总结了一下，没有保留路径', transcriptWithPath);
    expect(r.ok).toBe(false);
    expect(r.missingPaths).toBe(true);
  });

  it('flags dropped numeric evidence (≥3 numbers in transcript)', () => {
    const r = checkEvidencePreservation('总结了一下，没有保留数字', transcriptWithNumbers);
    expect(r.ok).toBe(false);
    expect(r.missingNumbers).toBe(true);
  });

  it('passes when summary retains the evidence', () => {
    const r = checkEvidencePreservation('see src/foo/bar.ts, values 123 456 789', transcriptWithPath);
    expect(r.ok).toBe(true);
  });

  it('checkFidelity surfaces missing evidence in missingEvidence', () => {
    const r = checkFidelity('任务目标：x', transcriptWithPath);
    expect(r.ok).toBe(false);
    expect(r.missingEvidence).toContain('文件路径证据');
  });
});

describe('fidelity-checker · compaction prompt contract', () => {
  it('instructs all nine sections', () => {
    const prompt = buildCompactionPrompt();
    for (const s of SUMMARY_SECTIONS) expect(prompt).toContain(s);
  });
});
