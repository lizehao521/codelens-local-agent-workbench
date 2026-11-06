/**
 * Fidelity checker (AC-09): mechanical self-check of the nine-section compression
 * summary. A summary missing any section FAILS — the loop then falls back to the
 * "context full" path instead of silently truncating.
 *
 * P2-2 hardening: section presence is matched by LINE STRUCTURE, not substring
 * inclusion. The old `summaryText.includes(section)` passed as soon as the model
 * wrote the section name anywhere — e.g. echoing the prompt's bullet list back —
 * so a summary that had lost a section's content still self-checked green. A
 * section now counts as present only when it HEADS a line (optional 【】/
 * markdown decoration, optional trailing colon), which is the format
 * buildCompactionPrompt demands.
 *
 * Two mechanical evidence floors complement the structure check, because a
 * heading with no content under it is still lossy: if the transcript carried
 * file paths / data-scale numbers, the summary must retain at least one of each
 * ("结论可溯源到原始来源"). The floors are deliberately minimal — a ratio would
 * fail legitimately terse summaries and stop tasks early (AC-09 fallback).
 */

export const SUMMARY_SECTIONS = [
  '任务目标',
  '关键决策',
  '已执行工具及结果',
  '用户偏好与约束',
  '未解决问题',
  '重要文件路径',
  '错误与恢复',
  '当前状态',
  '下一步计划',
] as const;

export type SummarySection = (typeof SUMMARY_SECTIONS)[number];

export interface FidelityResult {
  ok: boolean;
  present: SummarySection[];
  missing: SummarySection[];
  /** Evidence-floor violations (P2-2): paths / data numbers the summary dropped. */
  missingEvidence: string[];
}

/** Path-like tokens: `a/b`, `./x/y.txt`, `.artifacts/tc_1.json`, `src/foo.ts`. */
const PATH_PATTERN = /(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+/g;
/**
 * Data-scale numbers only: 3+ digit integers or any decimal. Index-ish 0-99
 * ("第 2 步", "-29") are incidental and must not fail a terse summary.
 */
const NUMBER_PATTERN = /(?:\d{3,}|\d+\.\d+)/g;

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/**
 * True when `section` heads a line of `text`: optional list/markdown decoration,
 * an optional 【】 wrapper, and an optional trailing colon. Mid-sentence mentions
 * do NOT count (the P2-2 cheat vector).
 */
function headsALine(text: string, section: string): boolean {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^[\\s#>*\\-\\d.、~]*[【\\[]?\\s*${escaped}`, 'm');
  return pattern.test(text);
}

/**
 * Evidence floors (P2-2). `transcript` is the exact text the summarizer saw.
 * A summary that drops every path (or every data number) breaks traceability
 * even with all nine headings present.
 */
export function checkEvidencePreservation(
  summaryText: string,
  transcript: string,
): { ok: boolean; missingPaths: boolean; missingNumbers: boolean } {
  const missingPaths = countMatches(transcript, PATH_PATTERN) > 0 && countMatches(summaryText, PATH_PATTERN) === 0;
  const missingNumbers =
    countMatches(transcript, NUMBER_PATTERN) >= 3 && countMatches(summaryText, NUMBER_PATTERN) === 0;
  return { ok: !missingPaths && !missingNumbers, missingPaths, missingNumbers };
}

/**
 * Extracts the nine sections from a summary document; order-independent.
 * Pass `transcript` (the summarized text) to also enforce the evidence floors.
 */
export function checkFidelity(summaryText: string, transcript?: string): FidelityResult {
  const present: SummarySection[] = [];
  const missing: SummarySection[] = [];
  for (const section of SUMMARY_SECTIONS) {
    if (headsALine(summaryText, section)) present.push(section);
    else missing.push(section);
  }
  const missingEvidence: string[] = [];
  if (transcript !== undefined) {
    const evidence = checkEvidencePreservation(summaryText, transcript);
    if (evidence.missingPaths) missingEvidence.push('文件路径证据');
    if (evidence.missingNumbers) missingEvidence.push('数字结论证据');
  }
  return { ok: missing.length === 0 && missingEvidence.length === 0, present, missing, missingEvidence };
}

/** Builds the compaction prompt instructing the model to emit all nine sections. */
export function buildCompactionPrompt(): string {
  return [
    '请把以下对话历史压缩为一份九段式摘要，每一段必须单独成行并以小标题开头（缺一不可）：',
    ...SUMMARY_SECTIONS.map((section) => `- ${section}`),
    '每段 1-3 句话，保留所有文件路径、数字结论与未解决事项。',
  ].join('\n');
}
