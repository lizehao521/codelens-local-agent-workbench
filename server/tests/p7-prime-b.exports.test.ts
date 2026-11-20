/**
 * P7′-b 专项测试（A10-A12 导出完备性、跳过声明与错误类型边界）。
 * 本文件仅使用内存数据与真实导出，不读真实库、不写文件、不触发内核运行。
 * 从 tests/p7-prime-b.test.ts 拆出（结构棘轮 ≤300 行）。
 */
import { describe, expect, it } from 'vitest';

import {
  CheckpointDisabledError,
  CheckpointManifestError,
  CheckpointNotFoundError,
  CheckpointPathError,
} from '../src/services/tx/checkpoint.service.js';
import { decodeSnapshot, encodeSnapshot } from '../src/services/judge/snapshot-codec.js';
import {
  createGenerationIdentity,
  CrossGenerationContractError,
  type GenerationIdentityInput,
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
  isZeroEffectiveDiff,
  normalizeFailureSignature,
} from '../src/services/rsi/cross-generation-stall.js';
import { decideRollback, detectOscillation } from '../src/services/rsi/cross-generation-oscillation.js';
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
import { environment, metrics, skipDeclarationText, tests, validIdentityInput } from './p7-prime-b.fixture.js';

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

