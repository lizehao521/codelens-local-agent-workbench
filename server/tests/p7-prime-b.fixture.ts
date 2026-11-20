/**
 * P7′-b 测试共用夹具（环境/指标/测试发现身份与 RunEvidence 工厂）。
 * 从 tests/p7-prime-b.test.ts 拆出（结构棘轮 ≤300 行）。
 */
import type {
  RestoreReport,
  RunEvidence,
  RunEvidenceStep,
  RunFileDiff,
} from '../src/services/tx/checkpoint.service.js';
import type {
  EnvironmentIdentity,
  GenerationIdentityInput,
  MetricDefinition,
  TestDiscoveryIdentity,
} from '../src/services/rsi/cross-generation-contract.js';
import type { GenerationRecord } from '../src/services/rsi/cross-generation-stall.js';

export const environment: EnvironmentIdentity = {
  runtime: 'node-v22',
  platform: 'linux',
  architecture: 'x64',
  dependencyLockHash: 'lock-hash-p7-prime-b',
  testRunnerVersion: 'vitest-test-runner',
};

export const metrics: readonly MetricDefinition[] = [
  {
    id: 'test_pass_rate',
    definitionVersion: '1',
    direction: 'higher_is_better',
    unit: 'ratio',
  },
];

export const tests: TestDiscoveryIdentity = {
  configHash: 'config-hash-p7-prime-b',
  tests: ['tests/p7-prime-b.test.ts'],
};

export const validIdentityInput: GenerationIdentityInput = {
  code: {
    revision: 'revision-p7-prime-b',
    sourceTreeHash: 'source-tree-hash-p7-prime-b',
  },
  tests,
  metrics,
  environment,
};

export const skipDeclarationText = `{
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

export function makeRunFileDiff(): RunFileDiff {
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

export function makeRunEvidenceStep(status: 'active' | 'pruned'): RunEvidenceStep {
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

export function makeRunEvidence(): RunEvidence {
  return {
    runId: 'run-p7-prime-b',
    sessions: ['session-1', 'session-2'],
    steps: [makeRunEvidenceStep('active'), makeRunEvidenceStep('pruned')],
    fileCount: 2,
    totalBytes: 30,
  };
}

export function makeGenerationRecord(rawText: string, diffText: string): GenerationRecord {
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

