/**
 * P2′ 零进展停止：公开类型（纯类型层）。
 * 从 cross-generation-stall.ts 拆出（结构棘轮 ≤300 行）；主模块 re-export。
 */

import type { EvidenceLevel } from './cross-generation-contract.js';
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
