/**
 * Judge：验证跨代身份指纹的稳定性、身份变化检测、证据升级链与错误模型，
 * 防止不同测试或指标口径被直接比较，也防止密钥进入环境身份。
 */

import { describe, expect, it } from 'vitest';
import {
  CROSS_GENERATION_CONTRACT_VERSION,
  CrossGenerationContractError,
  assertEvidenceTransition,
  compareGenerationIdentity,
  createGenerationIdentity,
  evaluateEvidenceTransition,
  validateEvidence,
  type GenerationIdentityInput,
} from './cross-generation-contract.js';

function makeIdentityInput(): GenerationIdentityInput {
  return {
    code: {
      revision: 'commit-a',
      sourceTreeHash: 'tree-a',
    },
    tests: {
      configHash: 'vitest-config-a',
      tests: ['src/services/rsi/b.test.ts', 'src/services/rsi/a.test.ts'],
    },
    metrics: [
      {
        id: 'test_pass_rate',
        definitionVersion: 'v1',
        direction: 'higher_is_better',
        unit: 'ratio',
      },
      {
        id: 'suite_floor_ratio',
        definitionVersion: 'v1',
        direction: 'higher_is_better',
        unit: 'ratio',
      },
    ],
    environment: {
      runtime: 'node-22',
      platform: 'linux',
      architecture: 'x64',
      dependencyLockHash: 'lock-a',
      testRunnerVersion: 'vitest-3',
    },
  };
}

function expectContractError(
  action: () => void,
  code: CrossGenerationContractError['code'],
): void {
  try {
    action();
    expect.unreachable('应抛出跨代契约错误');
  } catch (error) {
    expect(error).toBeInstanceOf(CrossGenerationContractError);
    expect((error as CrossGenerationContractError).code).toBe(code);
  }
}

describe('P0′ 跨代身份与证据契约', () => {
  it('相同输入指纹稳定，测试与指标顺序不影响身份', () => {
    const first = createGenerationIdentity(makeIdentityInput());
    const base = makeIdentityInput();
    const reordered: GenerationIdentityInput = {
      ...base,
      tests: {
        ...base.tests,
        tests: [...base.tests.tests].reverse(),
      },
      metrics: [...base.metrics].reverse(),
    };
    const second = createGenerationIdentity(reordered);

    expect(first.contractVersion).toBe(CROSS_GENERATION_CONTRACT_VERSION);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.tests.fingerprint).toBe(first.tests.fingerprint);
    expect(second.metricsFingerprint).toBe(first.metricsFingerprint);
    expect(second.environmentFingerprint).toBe(first.environmentFingerprint);
    expect(compareGenerationIdentity(first, second)).toEqual([]);
  });

  it.each([
    ['代码版本', (input: GenerationIdentityInput): GenerationIdentityInput => ({
      ...input,
      code: { ...input.code, revision: 'commit-b' },
    }), 'code.revision'],
    ['代码树', (input: GenerationIdentityInput): GenerationIdentityInput => ({
      ...input,
      code: { ...input.code, sourceTreeHash: 'tree-b' },
    }), 'code.sourceTreeHash'],
    ['测试发现集合', (input: GenerationIdentityInput): GenerationIdentityInput => ({
      ...input,
      tests: {
        ...input.tests,
        tests: [...input.tests.tests, 'src/services/rsi/c.test.ts'],
      },
    }), 'tests.discovery'],
    ['测试配置', (input: GenerationIdentityInput): GenerationIdentityInput => ({
      ...input,
      tests: { ...input.tests, configHash: 'vitest-config-b' },
    }), 'tests.discovery'],
    ['指标定义版本', (input: GenerationIdentityInput): GenerationIdentityInput => ({
      ...input,
      metrics: input.metrics.map((metric, index) =>
        index === 0 ? { ...metric, definitionVersion: 'v2' } : metric,
      ),
    }), 'metrics.definition'],
    ['指标方向', (input: GenerationIdentityInput): GenerationIdentityInput => ({
      ...input,
      metrics: input.metrics.map((metric, index) =>
        index === 0 ? { ...metric, direction: 'lower_is_better' as const } : metric,
      ),
    }), 'metrics.definition'],
    ['指标单位', (input: GenerationIdentityInput): GenerationIdentityInput => ({
      ...input,
      metrics: input.metrics.map((metric, index) =>
        index === 0 ? { ...metric, unit: 'percent' } : metric,
      ),
    }), 'metrics.definition'],
    ['运行时版本', (input: GenerationIdentityInput): GenerationIdentityInput => ({
      ...input,
      environment: { ...input.environment, runtime: 'node-23' },
    }), 'environment.version'],
    ['依赖锁哈希', (input: GenerationIdentityInput): GenerationIdentityInput => ({
      ...input,
      environment: { ...input.environment, dependencyLockHash: 'lock-b' },
    }), 'environment.version'],
  ])('任一身份字段变化均可检测：%s', (_name, change, expectedChange) => {
    const baseline = createGenerationIdentity(makeIdentityInput());
    const changedInput = change(makeIdentityInput());
    const changed = createGenerationIdentity(changedInput);

    expect(changed.fingerprint).not.toBe(baseline.fingerprint);
    expect(compareGenerationIdentity(baseline, changed)).toContain(expectedChange);
  });

  it('证据只能逐级升级，允许停留但禁止跳级和回退', () => {
    expect(evaluateEvidenceTransition('designed', 'designed').ok).toBe(true);
    expect(evaluateEvidenceTransition('designed', 'landed').ok).toBe(true);
    expect(evaluateEvidenceTransition('landed', 'targeted_passed').ok).toBe(true);
    expect(evaluateEvidenceTransition('targeted_passed', 'full_suite_passed').ok).toBe(true);
    expect(evaluateEvidenceTransition('full_suite_passed', 'runtime_verified').ok).toBe(true);

    expect(evaluateEvidenceTransition('designed', 'targeted_passed')).toEqual({
      ok: false,
      from: 'designed',
      to: 'targeted_passed',
      errorCode: 'EVIDENCE_LEVEL_SKIPPED',
    });
    expect(evaluateEvidenceTransition('runtime_verified', 'landed')).toEqual({
      ok: false,
      from: 'runtime_verified',
      to: 'landed',
      errorCode: 'EVIDENCE_REGRESSION',
    });
    expect(() => assertEvidenceTransition('designed', 'runtime_verified')).toThrow(
      CrossGenerationContractError,
    );
  });

  it('证据等级必须附带对应产物，designed 不需要伪造执行证据', () => {
    expect(() => validateEvidence({ level: 'designed' })).not.toThrow();
    expect(() => validateEvidence({ level: 'landed', landedFilesHash: 'files-hash' })).not.toThrow();
    expect(() => validateEvidence({
      level: 'targeted_passed',
      targetedTestCommand: 'vitest run cross-generation-contract',
    })).not.toThrow();
    expect(() => validateEvidence({
      level: 'full_suite_passed',
      fullSuiteCommand: 'npm test',
    })).not.toThrow();
    expect(() => validateEvidence({
      level: 'runtime_verified',
      runtimeEvidenceHash: 'runtime-evidence-hash',
    })).not.toThrow();

    expectContractError(
      () => validateEvidence({ level: 'runtime_verified' }),
      'EVIDENCE_ARTIFACT_MISSING',
    );
  });

  it('拒绝重复测试、重复指标、不稳定指标 ID 与空身份字段', () => {
    const duplicateBase = makeIdentityInput();
    const duplicateTests: GenerationIdentityInput = {
      ...duplicateBase,
      tests: {
        ...duplicateBase.tests,
        tests: ['a.test.ts', 'a.test.ts'],
      },
    };
    expectContractError(
      () => createGenerationIdentity(duplicateTests),
      'DUPLICATE_TEST_ID',
    );

    const duplicateMetricsBase = makeIdentityInput();
    const firstMetric = duplicateMetricsBase.metrics[0]!;
    const duplicateMetrics: GenerationIdentityInput = {
      ...duplicateMetricsBase,
      metrics: [firstMetric, firstMetric],
    };
    expectContractError(
      () => createGenerationIdentity(duplicateMetrics),
      'DUPLICATE_METRIC_ID',
    );

    const unstableBase = makeIdentityInput();
    const unstableMetric: GenerationIdentityInput = {
      ...unstableBase,
      metrics: unstableBase.metrics.map((metric, index) =>
        index === 0 ? { ...metric, id: 'Test Pass Rate' } : metric,
      ),
    };
    expectContractError(
      () => createGenerationIdentity(unstableMetric),
      'UNSTABLE_METRIC_ID',
    );

    const emptyBase = makeIdentityInput();
    const emptyRevision: GenerationIdentityInput = {
      ...emptyBase,
      code: { ...emptyBase.code, revision: '  ' },
    };
    expectContractError(
      () => createGenerationIdentity(emptyRevision),
      'EMPTY_IDENTITY_FIELD',
    );
  });

  it('环境身份模型不接收密钥字段，并拒绝敏感动态键', () => {
    const input = makeIdentityInput();
    const unsafeEnvironment = {
      ...input.environment,
      API_KEY: 'explicitly-rejected',
    };
    const unsafeInput = {
      ...input,
      environment: unsafeEnvironment,
    } as unknown as GenerationIdentityInput;

    expectContractError(
      () => createGenerationIdentity(unsafeInput),
      'SENSITIVE_ENVIRONMENT_FIELD',
    );
  });
});
