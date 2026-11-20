/**
 * 跨代判决：常量、错误码与结果类型（纯类型层）。
 * 从 cross-generation-verdict.ts 拆出（结构棘轮 ≤300 行）；主模块 re-export。
 */

import type { EvidenceLevel, GenerationEvidence, MetricDefinition, MetricDirection } from './cross-generation-contract.js';

export const CROSS_GENERATION_VERDICT_RULES_VERSION = 'cross-generation-verdict.v1';

export const CROSS_GENERATION_VERDICTS = [
  'improved',
  'not_improved',
  'undecidable',
  'refused',
] as const;

export type CrossGenerationVerdict = (typeof CROSS_GENERATION_VERDICTS)[number];

export type CrossGenerationVerdictErrorCode =
  | 'MULTIPLE_PRIMARY_OBJECTIVES'
  | 'MISSING_PRIMARY_OBJECTIVE'
  | 'MISSING_EVIDENCE_LEVEL'
  | 'INVALID_EVIDENCE'
  | 'EVIDENCE_REGRESSION'
  | 'EVIDENCE_LEVEL_SKIPPED'
  | 'INVALID_EVIDENCE_TRANSITION'
  | 'MISSING_PRIMARY_METRIC'
  | 'INCOMPARABLE_PRIMARY_METRIC'
  | 'PRIMARY_DEFINITION_CHANGED'
  | 'PRIMARY_DIRECTION_CHANGED'
  | 'PRIMARY_UNIT_CHANGED'
  | 'INVALID_INDICATOR_VALUE'
  | 'DUPLICATE_INDICATOR'
  | 'DUPLICATE_GUARD'
  | 'PRIMARY_IS_GUARD'
  | 'GUARD_DEFINITION_CHANGED'
  | 'MISSING_GUARD_METRIC'
  | 'INVALID_INPUT';

export class CrossGenerationVerdictError extends Error {
  public readonly code: CrossGenerationVerdictErrorCode;

  public constructor(code: CrossGenerationVerdictErrorCode, message: string) {
    super(message);
    this.name = 'CrossGenerationVerdictError';
    this.code = code;
  }
}

export interface IndicatorValue {
  readonly definition: MetricDefinition;
  readonly value: number;
}

export interface GenerationIndicators {
  readonly primary: IndicatorValue;
  readonly guards?: readonly IndicatorValue[];
  readonly diagnostics?: readonly IndicatorValue[];
}

export interface CrossGenerationVerdictInput {
  readonly rulesVersion: string;
  readonly previous: {
    readonly indicators: GenerationIndicators;
    readonly evidence: GenerationEvidence;
  };
  readonly next: {
    readonly indicators: GenerationIndicators;
    readonly evidence: GenerationEvidence;
  };
}

export interface MetricDelta {
  readonly id: string;
  readonly direction: MetricDirection;
  readonly previous: number;
  readonly next: number;
  readonly delta: number;
  readonly improved: boolean;
  readonly regressed: boolean;
}

export interface EvidenceTransitionSummary {
  readonly from: EvidenceLevel;
  readonly to: EvidenceLevel;
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly ok: boolean;
  readonly errorCode?: string;
}

export interface CrossGenerationVerdictResult {
  readonly verdict: CrossGenerationVerdict;
  readonly rulesVersion: string;
  readonly reason: string;
  readonly errorCode?: CrossGenerationVerdictErrorCode;
  readonly primary?: MetricDelta;
  readonly guards: readonly MetricDelta[];
  readonly diagnostics: readonly MetricDelta[];
  readonly evidenceTransition?: EvidenceTransitionSummary;
}

export interface VerdictStateTransition {
  readonly from: CrossGenerationVerdict | 'initial';
  readonly event:
    | 'evaluate'
    | 'primary_strictly_improved'
    | 'primary_not_improved'
    | 'guard_regressed'
    | 'primary_not_comparable'
    | 'multiple_primary_objectives'
    | 'missing_evidence_level'
    | 'invalid_evidence_transition';
  readonly to: CrossGenerationVerdict;
  readonly rule: string;
}
