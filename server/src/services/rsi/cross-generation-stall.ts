/**
 * P2′ 零进展停止模块
 *
 * 职责：
 *   1. 失败签名规范化（路径去前缀、行号归一、版本噪声归一、密钥脱敏）
 *   2. 连续两轮停止判定（同签名 / 零有效 diff / 零新增证据）
 *   3. 首轮总是 continue，不误停
 *
 * 硬约束：strict 无 any；import 用 .js；不改动 P0′/P1′ 文件。
 */

import type { EvidenceLevel, GenerationEvidence } from './cross-generation-contract.js';
import type { CrossGenerationVerdict } from './cross-generation-verdict.js';

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** 停止原因枚举 */
export const STALL_REASONS = [
  'signature_repeated',
  'zero_diff',
  'zero_evidence',
  'none',
] as const;
export type StallReason = (typeof STALL_REASONS)[number];

/** 单代失败输入（脱敏后的失败文本 + 结构化字段） */
export interface FailureInput {
  /** 脱敏后的原始失败文本（可含路径、行号、版本号、密钥——本模块负责规范化） */
  readonly rawText: string;
  /** 结构化错误类型（如 'TS2345'、'AssertionError'），可选 */
  readonly errorType?: string;
  /** 结构化错误消息主干，可选；若提供则优先于 rawText 提取 */
  readonly message?: string;
}

/** 单代 diff 输入 */
export interface DiffInput {
  /** unified diff 文本或任意源码变更文本 */
  readonly diffText: string;
}

/** 单代证据快照（用于零新增证据判定） */
export interface EvidenceSnapshot {
  readonly level: EvidenceLevel;
  /** 产物 hash（landedFilesHash 或 runtimeEvidenceHash 等），可选 */
  readonly artifactHash?: string;
}

/** 单代完整记录 */
export interface GenerationRecord {
  readonly failure?: FailureInput;
  readonly diff?: DiffInput;
  readonly evidence?: EvidenceSnapshot;
}

/** 停止判定结果 */
export interface StallVerdict {
  readonly stopped: boolean;
  readonly reason: StallReason;
  /** 人类可读说明 */
  readonly detail: string;
  /** 证据链引用：触发停止的两代索引（0-based），首轮为 [] */
  readonly evidenceChain: readonly number[];
  /** 关联的跨代判定（固定为 not_improved 或 undecidable） */
  readonly crossGenerationVerdict: CrossGenerationVerdict;
}

// ---------------------------------------------------------------------------
// 内部工具：密钥脱敏
// ---------------------------------------------------------------------------

/**
 * 对文本中的密钥模式进行脱敏替换。
 * 覆盖：Bearer token、sk-xxx、api_key=、password=、token=、Authorization header。
 */
function redactSecrets(text: string): string {
  return text
    // Authorization: Bearer <token>
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;"']+/gi, '$1[REDACTED]')
    // sk-<key>
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED_SK]')
    // api_key=<value> 或 api_key: <value>
    .replace(/(api_key\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
    // password=<value> 或 password: <value>
    .replace(/(password\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
    // token=<value> 或 token: <value>（不含 Bearer 已处理的情况）
    .replace(/(\btoken\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
    // secret=<value>
    .replace(/(\bsecret\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
}

// ---------------------------------------------------------------------------
// 内部工具：路径规范化
// ---------------------------------------------------------------------------

/**
 * 将绝对路径规范化为相对路径主干。
 * 策略：去掉已知前缀（/workspace/...、/tmp/...、/home/... 等），
 * 保留从 src/ 或最后一个有意义目录开始的部分。
 * 若无法识别前缀，则保留路径最后两段。
 */
function normalizePath(rawPath: string): string {
  // 统一分隔符
  const p = rawPath.replace(/\\/g, '/');
  // 尝试截取 src/ 之后的部分
  const srcMatch = p.match(/(?:^|\/)(src\/.+)$/);
  if (srcMatch !== null && srcMatch[1] !== undefined) {
    return srcMatch[1];
  }
  // 去掉常见绝对前缀
  const stripped = p.replace(/^(?:\/(?:workspace|tmp|home|var|opt|usr|root|build|dist|out)\/[^\s]*?\/)+/, '');
  if (stripped !== p && stripped.length > 0) {
    return stripped;
  }
  // 兜底：取最后两段
  const parts = p.split('/').filter((s) => s.length > 0);
  if (parts.length >= 2) {
    return parts.slice(-2).join('/');
  }
  return parts.join('/');
}

// ---------------------------------------------------------------------------
// 内部工具：行号/列号归一
// ---------------------------------------------------------------------------

/** 将 file.ts:42:10 或 file.ts:42 中的行号列号替换为占位符 */
function normalizeLineCol(text: string): string {
  // 匹配 path:line:col 或 path:line（在路径上下文中）
  return text.replace(/(\.[a-zA-Z]+):(\d+)(?::(\d+))?/g, (_m, ext: string) => `${ext}:LINE`);
}

// ---------------------------------------------------------------------------
// 内部工具：版本号归一
// ---------------------------------------------------------------------------

/** 将 v1.2.3 / 1.2.3 等语义版本号替换为占位符 */
function normalizeVersions(text: string): string {
  return text.replace(/\bv?\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?\b/g, 'VERSION');
}

// ---------------------------------------------------------------------------
// 轮1：失败签名规范化
// ---------------------------------------------------------------------------

/**
 * 对失败输入进行规范化，生成可比较的签名字符串。
 *
 * 处理步骤（顺序固定）：
 *   1. 密钥脱敏
 *   2. 路径去前缀
 *   3. 行号/列号归一
 *   4. 版本号归一
 *   5. 空白折叠
 *   6. 拼接 errorType + 规范化消息主干
 */
export function normalizeFailureSignature(failure: FailureInput): string {
  const rawMessage = failure.message ?? failure.rawText;

  // 1. 密钥脱敏
  let text = redactSecrets(rawMessage);

  // 2. 路径去前缀：匹配类 Unix 绝对路径
  text = text.replace(/(?:\/[^\s/]+)+\/[^\s:,]+/g, (match) => normalizePath(match));

  // 3. 行号/列号归一
  text = normalizeLineCol(text);

  // 4. 版本号归一
  text = normalizeVersions(text);

  // 5. 空白折叠
  text = text.replace(/\s+/g, ' ').trim();

  // 6. 拼接 errorType 前缀
  const prefix = failure.errorType !== undefined && failure.errorType.length > 0
    ? `${failure.errorType}::`
    : '';

  return `${prefix}${text}`;
}

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
