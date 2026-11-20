/**
 * P2′ 零进展停止模块
 *
 * 职责：
 *   1. 失败签名规范化（见 ./cross-generation-stall.signature.js）
 *   2. 连续两轮停止判定（同签名 / 零有效 diff / 零新增证据）
 *   3. 首轮总是 continue，不误停
 *
 * 硬约束：strict 无 any；import 用 .js；不改动 P0′/P1′ 文件。
 * 拆分说明（结构棘轮：单文件 ≤300 行）：类型 → .types.js；签名规范化 → .signature.js；
 * 下游 `from './cross-generation-stall.js'` 无需改动（原样 re-export）。
 */

import type { GenerationEvidence } from './cross-generation-contract.js';
import { normalizeFailureSignature } from './cross-generation-stall.signature.js';
import type { DiffInput, EvidenceSnapshot, GenerationRecord, StallVerdict } from './cross-generation-stall.types.js';

export * from './cross-generation-stall.types.js';
export { normalizeFailureSignature } from './cross-generation-stall.signature.js';

// ---------------------------------------------------------------------------
// 轮2 辅助：零有效 diff 判定
// ---------------------------------------------------------------------------

/**
 * 判断 diff 文本是否为零有效变更。
 *
 * 零有效 diff 定义：
 *   - 仅注释变化（块注释、行注释）
 *   - 仅空白变化（空格、tab、空行）
 *   - diff 文本为空
 *
 * 实现策略：剥离所有注释与空白后，比较剩余内容是否为空。
 * 对 unified diff 格式，只关注 +/- 行。
 */
export function isZeroEffectiveDiff(diff: DiffInput): boolean {
  const { diffText } = diff;

  if (diffText.trim().length === 0) {
    return true;
  }

  // 提取 unified diff 中的实际变更行（+/- 开头，排除 +++/--- 文件头）
  const changedLines = diffText
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return (
        (trimmed.startsWith('+') && !trimmed.startsWith('+++')) ||
        (trimmed.startsWith('-') && !trimmed.startsWith('---'))
      );
    })
    .map((line) => line.trimStart().slice(1)); // 去掉 +/- 前缀

  // 如果没有任何 +/- 行，视为零有效 diff
  if (changedLines.length === 0) {
    return true;
  }

  // 对变更行剥离注释与空白
  const stripped = changedLines
    .map((line) => stripCommentsAndWhitespace(line))
    .join('');

  return stripped.length === 0;
}

/**
 * 剥离单行中的行注释（// ...）与所有空白。
 * 注意：不处理跨行块注释（块注释由调用方在 join 后处理）。
 */
function stripCommentsAndWhitespace(line: string): string {
  // 去掉行注释
  const noLineComment = line.replace(/\/\/.*$/, '');
  // 去掉块注释（单行内的完整块注释）
  const noBlockComment = noLineComment.replace(/\/\*[^*]*\*\//g, '');
  // 去掉所有空白
  return noBlockComment.replace(/\s+/g, '');
}

/**
 * 对多行文本剥离所有注释（含跨行块注释）与空白。
 * 用于非 unified diff 格式的纯文本比较。
 */
function stripAllCommentsAndWhitespace(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '') // 跨行块注释
    .replace(/\/\/.*$/gm, '')           // 行注释
    .replace(/\s+/g, '');               // 所有空白
}

// ---------------------------------------------------------------------------
// 轮2 辅助：零新增证据判定
// ---------------------------------------------------------------------------

/**
 * 判断两代证据是否完全相同（零新增证据）。
 * 比较维度：level + artifactHash。
 */
export function isZeroNewEvidence(
  prev: EvidenceSnapshot,
  curr: EvidenceSnapshot,
): boolean {
  return prev.level === curr.level && prev.artifactHash === curr.artifactHash;
}

// ---------------------------------------------------------------------------
// 轮2：停止判定
// ---------------------------------------------------------------------------

/**
 * 评估当前代是否应停止（零进展停止）。
 *
 * @param history 历史记录数组，索引 0 为第一代；最后一代为当前代。
 *                数组长度 >= 1。长度为 1 时为首轮，总是 continue。
 * @returns StallVerdict
 */
export function evaluateStall(history: readonly GenerationRecord[]): StallVerdict {
  // 首轮总是 continue
  if (history.length <= 1) {
    return {
      stopped: false,
      reason: 'none',
      detail: '首轮，无历史可比较，继续。',
      evidenceChain: [],
      crossGenerationVerdict: 'undecidable',
    };
  }

  const currIdx = history.length - 1;
  const prevIdx = currIdx - 1;
  const curr = history[currIdx] as GenerationRecord;
  const prev = history[prevIdx] as GenerationRecord;

  // --- 判定 1：连续两轮相同失败签名 ---
  if (curr.failure !== undefined && prev.failure !== undefined) {
    const currSig = normalizeFailureSignature(curr.failure);
    const prevSig = normalizeFailureSignature(prev.failure);
    if (currSig === prevSig) {
      return {
        stopped: true,
        reason: 'signature_repeated',
        detail: `连续两轮失败签名相同（第 ${prevIdx} 代与第 ${currIdx} 代）：${currSig.slice(0, 120)}`,
        evidenceChain: [prevIdx, currIdx],
        crossGenerationVerdict: 'not_improved',
      };
    }
  }

  // --- 判定 2：零有效 diff ---
  if (curr.diff !== undefined) {
    if (isZeroEffectiveDiff(curr.diff)) {
      return {
        stopped: true,
        reason: 'zero_diff',
        detail: `第 ${currIdx} 代 diff 仅含注释/空白变化，零有效 diff。`,
        evidenceChain: [currIdx],
        crossGenerationVerdict: 'not_improved',
      };
    }
  }

  // --- 判定 3：零新增证据 ---
  if (curr.evidence !== undefined && prev.evidence !== undefined) {
    if (isZeroNewEvidence(prev.evidence, curr.evidence)) {
      return {
        stopped: true,
        reason: 'zero_evidence',
        detail: `第 ${prevIdx} 代与第 ${currIdx} 代证据 level 与 artifactHash 完全相同，零新增证据。`,
        evidenceChain: [prevIdx, currIdx],
        crossGenerationVerdict: 'not_improved',
      };
    }
  }

  // --- 无停止条件命中 ---
  return {
    stopped: false,
    reason: 'none',
    detail: '未命中任何零进展停止条件，继续。',
    evidenceChain: [],
    crossGenerationVerdict: 'undecidable',
  };
}

// ---------------------------------------------------------------------------
// 便捷工厂：从 GenerationEvidence 构造 EvidenceSnapshot
// ---------------------------------------------------------------------------

/**
 * 从 P0′ GenerationEvidence 提取 EvidenceSnapshot。
 * artifactHash 优先取 landedFilesHash，其次 runtimeEvidenceHash。
 */
export function evidenceSnapshotFromGenerationEvidence(
  evidence: GenerationEvidence,
): EvidenceSnapshot {
  const artifactHash = evidence.landedFilesHash ?? evidence.runtimeEvidenceHash;
  return {
    level: evidence.level,
    ...(artifactHash !== undefined ? { artifactHash } : {}),
  };
}

