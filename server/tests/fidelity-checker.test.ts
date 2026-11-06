/**
 * Fidelity checker (AC-09) — P2-2 regression net.
 *
 * The shipped defect: `summaryText.includes(section)` passed as soon as the
 * model wrote a section name ANYWHERE — e.g. echoing the compaction prompt's
 * bullet list back — so a summary that had lost the section's content still
 * self-checked green and the loop trusted it. Presence is now matched by line
 * structure (the section must head a line), and two mechanical evidence floors
 * catch headings with no content: if the transcript carried file paths or
 * data-scale numbers, the summary must retain at least one of each.
 */

import { describe, expect, it } from 'vitest';
import {
  SUMMARY_SECTIONS,
  checkEvidencePreservation,
  checkFidelity,
  buildCompactionPrompt,
} from '../src/services/agent/fidelity-checker.js';

function nineHeadings(): string {
  return SUMMARY_SECTIONS.map((section) => `【${section}】压缩后的内容`).join('\n');
}

describe('checkFidelity: section presence by line structure (P2-2)', () => {
  it('a summary with all nine headings passes', () => {
    const result = checkFidelity(nineHeadings());
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.present).toEqual([...SUMMARY_SECTIONS]);
  });

  it('the include-cheat fails: all nine names in one prose line is not nine sections', () => {
    // The old includes() check passed this — every name appears in the text.
    const cheat = `本次压缩覆盖了：${SUMMARY_SECTIONS.join('、')}，以上均已处理。`;
    expect(cheat).toContain('任务目标'); // the cheat vector itself

    const result = checkFidelity(cheat);
    expect(result.ok).toBe(false);
    // None of them heads a line, so ALL nine count as missing.
    expect(result.missing).toEqual([...SUMMARY_SECTIONS]);
  });

  it('mid-sentence mentions do not count as sections', () => {
    const result = checkFidelity('我们先回顾任务目标，然后看看错误与恢复的情况。');
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('任务目标');
    expect(result.missing).toContain('错误与恢复');
  });

  it('heading decoration is tolerated (【】, markdown, lists, colons)', () => {
    const decorated = [
      '【任务目标】完成迁移',
      '## 关键决策',
      '- 已执行工具及结果：fs_read',
      '1. 用户偏好与约束',
      '**未解决问题**：性能',
      '> 重要文件路径',
      '### 错误与恢复',
      '当前状态：进行中',
      '下一步计划',
    ].join('\n');
    const result = checkFidelity(decorated);
    expect(result.missing).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('missing sections are reported individually (loop surfaces them)', () => {
    const result = checkFidelity('【任务目标】只有一段');
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(8);
    expect(result.missing).not.toContain('任务目标');
  });
});

describe('checkEvidencePreservation: path/number floors (P2-2)', () => {
  const TRANSCRIPT_WITH_EVIDENCE = [
    '[user] 请检查 src/server/app.ts 和 .artifacts/tc_1.json',
    '[assistant] 延迟 1200 毫秒，重试 3 次后成功（成功率 0.98，耗时 450 毫秒）',
  ].join('\n');

  it('a summary that drops every path fails with a 文件路径证据 violation', () => {
    const evidence = checkEvidencePreservation('【重要文件路径】无', TRANSCRIPT_WITH_EVIDENCE);
    expect(evidence.missingPaths).toBe(true);
    expect(evidence.ok).toBe(false);
  });

  it('a summary that keeps at least one path passes the floor', () => {
    const evidence = checkEvidencePreservation('见 src/server/app.ts 的改动', TRANSCRIPT_WITH_EVIDENCE);
    expect(evidence.missingPaths).toBe(false);
  });

  it('a summary that drops every data-scale number fails', () => {
    const evidence = checkEvidencePreservation('延迟略有下降', TRANSCRIPT_WITH_EVIDENCE);
    expect(evidence.missingNumbers).toBe(true);
  });

  it('index-ish small numbers (-29, 第 2 步) do not trigger the floor', () => {
    const transcript = '第 1 步\n第 2 步\n第 3 步\n完成 29 项';
    const evidence = checkEvidencePreservation('已完成若干步', transcript);
    expect(evidence.missingNumbers).toBe(false);
  });

  it('checkFidelity folds evidence violations into missing (with the transcript)', () => {
    const result = checkFidelity(nineHeadings(), TRANSCRIPT_WITH_EVIDENCE);
    expect(result.missing).toEqual([]);
    expect(result.missingEvidence).toEqual(['文件路径证据', '数字结论证据']);
    expect(result.ok).toBe(false);
  });

  it('without a transcript the evidence floors are skipped (structure only)', () => {
    const result = checkFidelity(nineHeadings());
    expect(result.missingEvidence).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('buildCompactionPrompt', () => {
  it('still demands all nine sections and evidence preservation', () => {
    const prompt = buildCompactionPrompt();
    for (const section of SUMMARY_SECTIONS) expect(prompt).toContain(section);
    expect(prompt).toContain('单独成行'); // P2-2: the structure the checker now enforces
    expect(prompt).toContain('保留所有文件路径');
  });
});
