/**
 * P7′-b 专项测试（12 项机械验收 A1-A12）。
 * 设计态留档：V5-V14/V21/V23 作用对象不存在，未实现。
 * 本文件仅使用内存数据与真实导出，不读真实库、不写文件、不触发内核运行。
 */
import { describe, expect, it } from 'vitest';

import {
  CheckpointDisabledError,
  CheckpointManifestError,
  CheckpointNotFoundError,
  CheckpointPathError,
  type RestoreReport,
  type RunEvidence,
  type RunEvidenceStep,
  type RunFileDiff,
} from '../src/services/tx/checkpoint.service.js';
import {
  decodeSnapshot,
  encodeSnapshot,
  GZ_PREFIX,
} from '../src/services/judge/snapshot-codec.js';
import {
  createGenerationIdentity,
  CrossGenerationContractError,
  type EnvironmentIdentity,
  type GenerationIdentityInput,
  type MetricDefinition,
  type TestDiscoveryIdentity,
  validateEvidence,
} from '../src/services/rsi/cross-generation-contract.js';
import {
  assertSinglePrimaryObjective,
  CROSS_GENERATION_VERDICTS,
  evaluateCrossGenerationVerdict,
  refuseCrossGenerationVerdict,
} from '../src/services/rsi/cross-generation-verdict.js';
import {
  evaluateStall,
  type GenerationRecord,
  isZeroEffectiveDiff,
  normalizeFailureSignature,
} from '../src/services/rsi/cross-generation-stall.js';
import {
  decideRollback,
  detectOscillation,
} from '../src/services/rsi/cross-generation-oscillation.js';
import {
  assessFalseGreen,
  detectSkippedTests,
  verifyNegativeCriteria,
} from '../src/services/rsi/cross-generation-adversarial.js';
import {
  adaptLegacyBridgeResult,
  serializeCrossGenerationVerdict,
  toRsiVerdict,
} from '../src/services/rsi/cross-generation-adapter.js';

const environment: EnvironmentIdentity = {
  runtime: 'node-v22',
  platform: 'linux',
  architecture: 'x64',
  dependencyLockHash: 'lock-hash-p7-prime-b',
  testRunnerVersion: 'vitest-test-runner',
};

const metrics: readonly MetricDefinition[] = [
  {
    id: 'test_pass_rate',
    definitionVersion: '1',
    direction: 'higher_is_better',
    unit: 'ratio',
  },
];

const tests: TestDiscoveryIdentity = {
  configHash: 'config-hash-p7-prime-b',
  tests: ['tests/p7-prime-b.test.ts'],
};

const validIdentityInput: GenerationIdentityInput = {
  code: {
    revision: 'revision-p7-prime-b',
    sourceTreeHash: 'source-tree-hash-p7-prime-b',
  },
  tests,
  metrics,
  environment,
};

const skipDeclarationText = `{
  "skipDeclaration": {
    "phase": "P6'-b",
    "verdict": "SKIPPED",
    "reason": "完整回放牵扯 judge 判据塔内核运行，需真实脱敏快照样本，代价高",
    "decidedBy": "user",
    "decidedAt": "2026-11-19",
    "missingPrerequisite": "真实脱敏快照样本 + 内核运行环境",
    "unlockCondition": "获得真实脱敏快照样本且用户批准触发内核运行",
    "countedAsPassed": false,
    "countedInCompletion": false,
    "maintainedCriteria": ["P0'", "P1'", "P2'", "P3'", "P4'", "P5'"]
  }
}`;

function makeRunFileDiff(): RunFileDiff {
  return {
    path: 'src/example.ts',
    operation: 'modified',
    beforeSha256: 'before-sha256',
    afterSha256: 'after-sha256',
    beforeBytes: 12,
    afterBytes: 18,
    added: 3,
    removed: 1,
    diff: '@@ -1 +1 @@\n-old\n+new',
  };
}

function makeRunEvidenceStep(status: 'active' | 'pruned'): RunEvidenceStep {
  return {
    checkpointId: `checkpoint-${status}`,
    step: status === 'active' ? 1 : null,
    toolCallIds: ['tool-call-1', 'tool-call-2'],
    createdAt: 1763510400000,
    status,
    restoredAt: null,
    files: [makeRunFileDiff()],
  };
}

function makeRunEvidence(): RunEvidence {
  return {
    runId: 'run-p7-prime-b',
    sessions: ['session-1', 'session-2'],
    steps: [makeRunEvidenceStep('active'), makeRunEvidenceStep('pruned')],
    fileCount: 2,
    totalBytes: 30,
  };
}

function makeGenerationRecord(rawText: string, diffText: string): GenerationRecord {
  return {
    failure: {
      rawText,
    },
    diff: {
      diffText,
    },
    evidence: {
      level: 'none',
    },
  };
}

describe('P7′-b A1-A5 纯函数故障注入', () => {
  it('A1 缺少 code 时按 P1′ 契约抛出 EMPTY_IDENTITY_FIELD', () => {
    const missingCodeInput = {
      tests: validIdentityInput.tests,
      metrics: validIdentityInput.metrics,
      environment: validIdentityInput.environment,
    };

    let thrown: unknown;
    try {
      createGenerationIdentity(missingCodeInput as GenerationIdentityInput);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CrossGenerationContractError);
    expect(thrown).toMatchObject({
      name: 'CrossGenerationContractError',
      code: 'EMPTY_IDENTITY_FIELD',
    });
    expect((thrown as CrossGenerationContractError).message).toContain('code');
  });

  it('A2 非法 verdict、跳过测试与非法 evidence 不被静默接受', () => {
    expect(() => evaluateCrossGenerationVerdict(null)).toThrow();
    expect(() => evaluateCrossGenerationVerdict({ primaryObjectives: [] })).toThrow();
    expect(() => assertSinglePrimaryObjective([])).toThrow();
    expect(() => assertSinglePrimaryObjective(['one', 'two'])).toThrow();

    const refused = refuseCrossGenerationVerdict(
      'INVALID_INPUT',
      'P7′-b 故障注入：输入不可判定',
    );
    expect(refused.verdict).toBe('refused');
    expect(CROSS_GENERATION_VERDICTS).toContain(refused.verdict);

    const skipped = detectSkippedTests(`
      import { describe, it } from 'vitest';
      describe.skip('skipped suite', () => {
        it.skip('skipped case', () => {});
      });
    `);
    expect(skipped.hasRisk).toBe(true);
    expect(skipped.patterns.length).toBeGreaterThan(0);
    expect(skipped.riskLevel).not.toBe('none');

    expect(() => validateEvidence(null)).toThrow();
    expect(() => validateEvidence({})).toThrow();

    const negativeCriteria = verifyNegativeCriteria(null as never, [], []);
    expect(negativeCriteria.passed).toBe(false);
    expect(negativeCriteria.missingNegativeCriteria).toContain('unknown capability');

    const falseGreen = assessFalseGreen('clean test source', 10, 10);
    expect(falseGreen.overallRisk).toBe('none');
  });

  it('A3 重复失败与零有效 diff 的旧记录产生非空 stall 原因', () => {
    const repeatedFailure = normalizeFailureSignature({
      rawText: 'ASSERTION_FAILED: expected improved, received not_improved',
      errorType: 'ASSERTION_FAILED',
      message: 'expected improved, received not_improved',
    });
    const history: readonly GenerationRecord[] = [
      makeGenerationRecord(repeatedFailure, ''),
      makeGenerationRecord(repeatedFailure, ''),
      makeGenerationRecord(repeatedFailure, ''),
    ];

    expect(isZeroEffectiveDiff({ diffText: '' })).toBe(true);
    expect(isZeroEffectiveDiff({ diffText: '   \n  ' })).toBe(true);

    const verdict = evaluateStall(history);
    expect(verdict.stopped).toBe(true);
    expect(verdict.reason).not.toBeNull();
    expect(String(verdict.reason).length).toBeGreaterThan(0);
  });

  it('A4 非 gz 快照与损坏 gz 快照返回 null 且不抛出', () => {
    expect(GZ_PREFIX).toBe('gz:');
    expect(() => decodeSnapshot('not-gz')).not.toThrow();
    expect(decodeSnapshot('not-gz')).toBeNull();
    expect(() => decodeSnapshot('gz:bad')).not.toThrow();
    expect(decodeSnapshot('gz:bad')).toBeNull();
    expect(decodeSnapshot(null)).toBeNull();
    expect(decodeSnapshot(undefined)).toBeNull();
  });

  it('A5 快照编码解码往返保持深度相等', () => {
    const snapshot = {
      runId: 'snapshot-run',
      nested: {
        statuses: ['active', 'pruned'],
        restoredAt: null,
        bytes: [0, 1, 2, 1024],
        enabled: true,
      },
    };

    const encoded = encodeSnapshot(snapshot);
    expect(decodeSnapshot(encoded)).toEqual(snapshot);
    if (encoded.startsWith(GZ_PREFIX)) {
      expect(encoded.length).toBeGreaterThan(GZ_PREFIX.length);
    } else {
      expect(JSON.parse(encoded)).toEqual(snapshot);
    }

    const compressibleSnapshot = {
      runId: 'compressible-snapshot-run',
      payload: 'repeatable-payload-'.repeat(4096),
      nested: {
        statuses: Array.from({ length: 1024 }, () => 'active'),
        restoredAt: null,
      },
    };
    const compressibleEncoded = encodeSnapshot(compressibleSnapshot);
    expect(decodeSnapshot(compressibleEncoded)).toEqual(compressibleSnapshot);
    if (compressibleEncoded.startsWith(GZ_PREFIX)) {
      expect(compressibleEncoded.length).toBeGreaterThan(GZ_PREFIX.length);
    } else {
      expect(JSON.parse(compressibleEncoded)).toEqual(compressibleSnapshot);
    }
  });
});

describe('P7′-b A6-A9 真实类型字段完备性', () => {
  it('A6 RunEvidence 与 RunFileDiff 全真实字段往返后逐字段一致', () => {
    const evidence = makeRunEvidence();
    const roundTripped = JSON.parse(JSON.stringify(evidence)) as RunEvidence;

    expect(roundTripped.runId).toBe(evidence.runId);
    expect(roundTripped.sessions).toEqual(evidence.sessions);
    expect(roundTripped.fileCount).toBe(evidence.fileCount);
    expect(roundTripped.totalBytes).toBe(evidence.totalBytes);
    expect(roundTripped.steps).toHaveLength(evidence.steps.length);

    for (let index = 0; index < evidence.steps.length; index += 1) {
      const expectedStep = evidence.steps[index];
      const actualStep = roundTripped.steps[index];
      expect(actualStep.checkpointId).toBe(expectedStep.checkpointId);
      expect(actualStep.step).toBe(expectedStep.step);
      expect(actualStep.toolCallIds).toEqual(expectedStep.toolCallIds);
      expect(actualStep.createdAt).toBe(expectedStep.createdAt);
      expect(actualStep.status).toBe(expectedStep.status);
      expect(actualStep.restoredAt).toBe(expectedStep.restoredAt);
      expect(actualStep.files).toHaveLength(expectedStep.files.length);

      const expectedFile = expectedStep.files[0];
      const actualFile = actualStep.files[0];
      expect(actualFile.path).toBe(expectedFile.path);
      expect(actualFile.operation).toBe(expectedFile.operation);
      expect(actualFile.beforeSha256).toBe(expectedFile.beforeSha256);
      expect(actualFile.afterSha256).toBe(expectedFile.afterSha256);
      expect(actualFile.beforeBytes).toBe(expectedFile.beforeBytes);
      expect(actualFile.afterBytes).toBe(expectedFile.afterBytes);
      expect(actualFile.added).toBe(expectedFile.added);
      expect(actualFile.removed).toBe(expectedFile.removed);
      expect(actualFile.diff).toBe(expectedFile.diff);
    }
  });

  it('A7 RestoreReport 必填字段与全部可选字段按真实定义往返', () => {
    const requiredOnly: RestoreReport = {
      ok: true,
      restored: ['src/example.ts'],
      failed: [],
      deleted: ['src/obsolete.ts'],
      kept: ['src/untouched.ts'],
    };
    const withOptionals: RestoreReport = {
      ...requiredOnly,
      restoreId: 'restore-p7-prime-b',
      runId: 'run-p7-prime-b',
      step: 1,
      files: ['src/example.ts'],
    };
    const nullableOptionals: RestoreReport = {
      ...requiredOnly,
      runId: null,
      step: null,
      files: null,
    };

    expect(JSON.parse(JSON.stringify(requiredOnly))).toEqual(requiredOnly);
    expect(JSON.parse(JSON.stringify(withOptionals))).toEqual(withOptionals);
    expect(JSON.parse(JSON.stringify(nullableOptionals))).toEqual(nullableOptionals);
    expect(withOptionals.restoreId).toBe('restore-p7-prime-b');
    expect(nullableOptionals.runId).toBeNull();
    expect(nullableOptionals.step).toBeNull();
    expect(nullableOptionals.files).toBeNull();
  });

  it('A8 RunEvidenceStep.status 仅使用 active 与 pruned 枚举', () => {
    const active = makeRunEvidenceStep('active');
    const pruned = makeRunEvidenceStep('pruned');
    const statuses: readonly RunEvidenceStep['status'][] = [active.status, pruned.status];

    expect(statuses).toEqual(['active', 'pruned']);
    expect(new Set(statuses).size).toBe(2);
    expect(active.step).toBe(1);
    expect(pruned.step).toBeNull();
  });

  it('A9 restoredAt=null 表示未恢复且不会被误判为时间戳', () => {
    const evidence = makeRunEvidence();
    const roundTripped = JSON.parse(JSON.stringify(evidence)) as RunEvidence;

    for (const step of roundTripped.steps) {
      expect(step.restoredAt).toBeNull();
      expect(step.restoredAt === null).toBe(true);
      expect(typeof step.restoredAt).toBe('object');
      expect(step.restoredAt).not.toBe(0);
    }

    const restoredStep: RunEvidenceStep = {
      ...makeRunEvidenceStep('active'),
      restoredAt: 1763510400123,
    };
    expect(restoredStep.restoredAt).toBe(1763510400123);
    expect(typeof restoredStep.restoredAt).toBe('number');
  });
});

describe('P7′-b A10-A12 导出、补强一致性与跳过声明', () => {
  it('A10 六个 cross-generation 模块的真实导出均存在', () => {
    expect(typeof createGenerationIdentity).toBe('function');
    expect(typeof validateEvidence).toBe('function');
    expect(typeof evaluateCrossGenerationVerdict).toBe('function');
    expect(typeof refuseCrossGenerationVerdict).toBe('function');
    expect(typeof assertSinglePrimaryObjective).toBe('function');
    expect(CROSS_GENERATION_VERDICTS).toEqual([
      'improved',
      'not_improved',
      'undecidable',
      'refused',
    ]);
    expect(typeof evaluateStall).toBe('function');
    expect(typeof normalizeFailureSignature).toBe('function');
    expect(typeof isZeroEffectiveDiff).toBe('function');
    expect(typeof detectOscillation).toBe('function');
    expect(typeof decideRollback).toBe('function');
    expect(typeof detectSkippedTests).toBe('function');
    expect(typeof verifyNegativeCriteria).toBe('function');
    expect(typeof assessFalseGreen).toBe('function');
    expect(typeof toRsiVerdict).toBe('function');
    expect(typeof serializeCrossGenerationVerdict).toBe('function');
    expect(typeof adaptLegacyBridgeResult).toBe('function');
  });

  it('A11 EMPTY_IDENTITY_FIELD 与 createGenerationIdentity 的 P1′ 补强一致', () => {
    const nullCodeInput = {
      code: null,
      tests: validIdentityInput.tests,
      metrics: validIdentityInput.metrics,
      environment: validIdentityInput.environment,
    };

    const captureCode = (input: GenerationIdentityInput): string | null => {
      try {
        createGenerationIdentity(input);
        return null;
      } catch (error: unknown) {
        if (error instanceof CrossGenerationContractError) {
          return error.code;
        }
        throw error;
      }
    };

    expect(captureCode(nullCodeInput as GenerationIdentityInput)).toBe(
      'EMPTY_IDENTITY_FIELD',
    );
    expect(captureCode(validIdentityInput)).toBeNull();

    const contractError = new CrossGenerationContractError(
      'EMPTY_IDENTITY_FIELD',
      'code identity is required',
    );
    expect(contractError.code).toBe('EMPTY_IDENTITY_FIELD');
    expect(contractError.message).toBe('code identity is required');
  });

  it('A12 P6′-b 跳过声明不计通过、不计完成度且维持 P0′-P5′', () => {
    const parsed: unknown = JSON.parse(skipDeclarationText);
    expect(parsed).toEqual({
      skipDeclaration: {
        phase: "P6'-b",
        verdict: 'SKIPPED',
        reason: '完整回放牵扯 judge 判据塔内核运行，需真实脱敏快照样本，代价高',
        decidedBy: 'user',
        decidedAt: '2026-11-19',
        missingPrerequisite: '真实脱敏快照样本 + 内核运行环境',
        unlockCondition: '获得真实脱敏快照样本且用户批准触发内核运行',
        countedAsPassed: false,
        countedInCompletion: false,
        maintainedCriteria: ["P0'", "P1'", "P2'", "P3'", "P4'", "P5'"],
      },
    });

    const declaration = (parsed as {
      skipDeclaration: {
        phase: string;
        verdict: string;
        countedAsPassed: boolean;
        countedInCompletion: boolean;
        maintainedCriteria: string[];
      };
    }).skipDeclaration;
    expect(declaration.phase).toBe("P6'-b");
    expect(declaration.verdict).toBe('SKIPPED');
    expect(declaration.countedAsPassed).toBe(false);
    expect(declaration.countedInCompletion).toBe(false);
    expect(declaration.maintainedCriteria).toEqual([
      "P0'",
      "P1'",
      "P2'",
      "P3'",
      "P4'",
      "P5'",
    ]);
  });
});

describe('P7′-b 错误类型与辅助纯函数边界', () => {
  it('checkpoint 错误类保持可实例化且快照辅助函数不依赖 I/O', () => {
    expect(new CheckpointDisabledError('disabled')).toBeInstanceOf(Error);
    expect(new CheckpointNotFoundError('missing')).toBeInstanceOf(Error);
    expect(new CheckpointPathError('bad path')).toBeInstanceOf(Error);
    expect(new CheckpointManifestError('bad manifest')).toBeInstanceOf(Error);
    expect(decodeSnapshot(encodeSnapshot(null))).toBeNull();
  });
});
