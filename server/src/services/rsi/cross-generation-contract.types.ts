/**
 * 跨代契约：证据等级、身份结构与错误类型的纯类型层。
 *
 * 从 cross-generation-contract.ts 拆出（结构棘轮：单文件 ≤300 行）。
 * 主模块 re-export 本文件全部导出，下游 `from './cross-generation-contract.js'` 无需改动。
 */

import type { RsiRulesContract } from './rules-contract.js';
import type { IterationRecord } from './iteration-store.js';

export const CROSS_GENERATION_CONTRACT_VERSION = 'cross-generation-contract-v1' as const;

export const EVIDENCE_LEVELS = [
  'designed',
  'landed',
  'targeted_passed',
  'full_suite_passed',
  'runtime_verified',
] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export type MetricDirection = 'higher_is_better' | 'lower_is_better';

export interface MetricDefinition {
  readonly id: string;
  readonly definitionVersion: string;
  readonly direction: MetricDirection;
  readonly unit: string;
}

export interface EnvironmentIdentity {
  readonly runtime: string;
  readonly platform: string;
  readonly architecture: string;
  readonly dependencyLockHash: string;
  readonly testRunnerVersion: string;
}

export interface CodeBaselineIdentity {
  readonly revision: string;
  readonly sourceTreeHash: string;
}

export interface TestDiscoveryIdentity {
  readonly configHash: string;
  readonly tests: readonly string[];
}

export interface GenerationIdentityInput {
  readonly code: CodeBaselineIdentity;
  readonly tests: TestDiscoveryIdentity;
  readonly metrics: readonly MetricDefinition[];
  readonly environment: EnvironmentIdentity;
}

export interface GenerationIdentity extends GenerationIdentityInput {
  readonly contractVersion: typeof CROSS_GENERATION_CONTRACT_VERSION;
  readonly tests: TestDiscoveryIdentity & { readonly fingerprint: string };
  readonly metricsFingerprint: string;
  readonly environmentFingerprint: string;
  readonly fingerprint: string;
}

export interface GenerationEvidence {
  readonly level: EvidenceLevel;
  readonly landedFilesHash?: string;
  readonly targetedTestCommand?: string;
  readonly fullSuiteCommand?: string;
  readonly runtimeEvidenceHash?: string;
}

/**
 * 跨代记录引用的迭代身份。
 * version 直接复用 IterationRecord 真实存在的字段；
 * parentIterationId 与 iterationHash 是本契约自有的可选字段，由调用方提供：
 * - parentIterationId 来源：父代 IterationRecord.id；
 * - iterationHash 来源：迭代账本（raw: LedgerRow）内容的哈希，由账本侧计算。
 * 不为 IterationRecord 增加任何字段。
 */
export interface CrossGenerationIterationRef {
  readonly version: IterationRecord['version'];
  readonly parentIterationId?: string;
  readonly iterationHash?: string;
}

export interface CrossGenerationRecord {
  readonly identity: GenerationIdentity;
  readonly rulesVersion: RsiRulesContract['version'];
  readonly iteration: CrossGenerationIterationRef;
  readonly evidence: GenerationEvidence;
}

export type CrossGenerationContractErrorCode =
  | 'EMPTY_IDENTITY_FIELD'
  | 'DUPLICATE_TEST_ID'
  | 'DUPLICATE_METRIC_ID'
  | 'UNSTABLE_METRIC_ID'
  | 'SENSITIVE_ENVIRONMENT_FIELD'
  | 'INVALID_EVIDENCE_LEVEL'
  | 'EVIDENCE_REGRESSION'
  | 'EVIDENCE_LEVEL_SKIPPED'
  | 'EVIDENCE_ARTIFACT_MISSING';

export class CrossGenerationContractError extends Error {
  readonly code: CrossGenerationContractErrorCode;

  constructor(code: CrossGenerationContractErrorCode, message: string) {
    super(message);
    this.name = 'CrossGenerationContractError';
    this.code = code;
  }
}

export interface EvidenceTransitionResult {
  readonly ok: boolean;
  readonly from: EvidenceLevel;
  readonly to: EvidenceLevel;
  readonly errorCode?: Extract<
    CrossGenerationContractErrorCode,
    'INVALID_EVIDENCE_LEVEL' | 'EVIDENCE_REGRESSION' | 'EVIDENCE_LEVEL_SKIPPED'
  >;
}
