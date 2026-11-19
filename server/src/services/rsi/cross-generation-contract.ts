/**
 * Judge：定义跨代改进判决的身份、证据等级与稳定指纹契约，
 * 复用既有规则版本和迭代哈希，确保只有同口径的代际记录可以比较。
 */

import { createHash } from 'node:crypto';
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

const SENSITIVE_FIELD = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token)/i;
const STABLE_METRIC_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new CrossGenerationContractError(
      'EMPTY_IDENTITY_FIELD',
      `${field} 必须是非空字符串`,
    );
  }
  return normalized;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortValue(entry)]));
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

function assertSafeEnvironmentKey(key: string): void {
  if (SENSITIVE_FIELD.test(key)) {
    throw new CrossGenerationContractError(
      'SENSITIVE_ENVIRONMENT_FIELD',
      `环境身份字段 ${key} 可能包含密钥，只允许固定版本标识`,
    );
  }
}

function normalizeTests(identity: TestDiscoveryIdentity): TestDiscoveryIdentity & { fingerprint: string } {
  const configHash = requiredText(identity.configHash, 'tests.configHash');
  const tests = identity.tests.map((test) => requiredText(test, 'tests.tests[]'));
  const uniqueTests = [...new Set(tests)].sort((left, right) => left.localeCompare(right));
  if (uniqueTests.length !== tests.length) {
    throw new CrossGenerationContractError(
      'DUPLICATE_TEST_ID',
      '测试发现集合包含重复或仅空白不同的测试 ID',
    );
  }
  return {
    configHash,
    tests: uniqueTests,
    fingerprint: fingerprint({ configHash, tests: uniqueTests }),
  };
}

function normalizeMetrics(metrics: readonly MetricDefinition[]): readonly MetricDefinition[] {
  const normalized = metrics.map((metric) => {
    const id = requiredText(metric.id, 'metrics[].id');
    if (!STABLE_METRIC_ID.test(id)) {
      throw new CrossGenerationContractError(
        'UNSTABLE_METRIC_ID',
        `指标 ID ${id} 不符合稳定标识格式`,
      );
    }
    return {
      id,
      definitionVersion: requiredText(metric.definitionVersion, `metrics.${id}.definitionVersion`),
      direction: metric.direction,
      unit: requiredText(metric.unit, `metrics.${id}.unit`),
    };
  });
  const ids = new Set(normalized.map((metric) => metric.id));
  if (ids.size !== normalized.length) {
    throw new CrossGenerationContractError(
      'DUPLICATE_METRIC_ID',
      '指标定义包含重复 ID',
    );
  }
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeEnvironment(identity: EnvironmentIdentity): EnvironmentIdentity {
  for (const key of Object.keys(identity)) {
    assertSafeEnvironmentKey(key);
  }
  return {
    runtime: requiredText(identity.runtime, 'environment.runtime'),
    platform: requiredText(identity.platform, 'environment.platform'),
    architecture: requiredText(identity.architecture, 'environment.architecture'),
    dependencyLockHash: requiredText(
      identity.dependencyLockHash,
      'environment.dependencyLockHash',
    ),
    testRunnerVersion: requiredText(
      identity.testRunnerVersion,
      'environment.testRunnerVersion',
    ),
  };
}

export function createGenerationIdentity(
  input: GenerationIdentityInput,
): GenerationIdentity {
  if (input.code === undefined || input.code === null) {
    throw new CrossGenerationContractError(
      'EMPTY_IDENTITY_FIELD',
      'Generation identity requires code',
    );
  }
  const code = {
    revision: requiredText(input.code.revision, 'code.revision'),
    sourceTreeHash: requiredText(input.code.sourceTreeHash, 'code.sourceTreeHash'),
  };
  const tests = normalizeTests(input.tests);
  const metrics = normalizeMetrics(input.metrics);
  const environment = normalizeEnvironment(input.environment);
  const metricsFingerprint = fingerprint(metrics);
  const environmentFingerprint = fingerprint(environment);
  const identityFingerprint = fingerprint({
    contractVersion: CROSS_GENERATION_CONTRACT_VERSION,
    code,
    testsFingerprint: tests.fingerprint,
    metricsFingerprint,
    environmentFingerprint,
  });
  return {
    contractVersion: CROSS_GENERATION_CONTRACT_VERSION,
    code,
    tests,
    metrics,
    environment,
    metricsFingerprint,
    environmentFingerprint,
    fingerprint: identityFingerprint,
  };
}

export function evidenceLevelIndex(level: EvidenceLevel): number {
  const index = EVIDENCE_LEVELS.indexOf(level);
  if (index < 0) {
    throw new CrossGenerationContractError(
      'INVALID_EVIDENCE_LEVEL',
      `未知证据等级 ${String(level)}`,
    );
  }
  return index;
}

export function evaluateEvidenceTransition(
  from: EvidenceLevel,
  to: EvidenceLevel,
): EvidenceTransitionResult {
  const fromIndex = evidenceLevelIndex(from);
  const toIndex = evidenceLevelIndex(to);
  if (toIndex < fromIndex) {
    return { ok: false, from, to, errorCode: 'EVIDENCE_REGRESSION' };
  }
  if (toIndex > fromIndex + 1) {
    return { ok: false, from, to, errorCode: 'EVIDENCE_LEVEL_SKIPPED' };
  }
  return { ok: true, from, to };
}

export function assertEvidenceTransition(
  from: EvidenceLevel,
  to: EvidenceLevel,
): void {
  const result = evaluateEvidenceTransition(from, to);
  if (!result.ok) {
    throw new CrossGenerationContractError(
      result.errorCode ?? 'INVALID_EVIDENCE_LEVEL',
      `证据等级不得从 ${from} 直接变为 ${to}`,
    );
  }
}

export function validateEvidence(evidence: GenerationEvidence): void {
  evidenceLevelIndex(evidence.level);
  const requiredArtifact: Partial<Record<EvidenceLevel, keyof GenerationEvidence>> = {
    landed: 'landedFilesHash',
    targeted_passed: 'targetedTestCommand',
    full_suite_passed: 'fullSuiteCommand',
    runtime_verified: 'runtimeEvidenceHash',
  };
  const artifact = requiredArtifact[evidence.level];
  if (artifact !== undefined) {
    const value = evidence[artifact];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new CrossGenerationContractError(
        'EVIDENCE_ARTIFACT_MISSING',
        `${evidence.level} 缺少 ${artifact} 证据`,
      );
    }
  }
}

export function compareGenerationIdentity(
  previous: GenerationIdentity,
  current: GenerationIdentity,
): readonly string[] {
  const changes: string[] = [];
  if (previous.code.revision !== current.code.revision) changes.push('code.revision');
  if (previous.code.sourceTreeHash !== current.code.sourceTreeHash) {
    changes.push('code.sourceTreeHash');
  }
  if (previous.tests.fingerprint !== current.tests.fingerprint) {
    changes.push('tests.discovery');
  }
  if (previous.metricsFingerprint !== current.metricsFingerprint) {
    changes.push('metrics.definition');
  }
  if (previous.environmentFingerprint !== current.environmentFingerprint) {
    changes.push('environment.version');
  }
  return changes;
}
