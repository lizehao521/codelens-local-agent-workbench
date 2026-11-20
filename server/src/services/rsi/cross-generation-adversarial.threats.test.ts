/**
 * P4′ 对抗与防假绿测试——威胁分类模型与负向判据强制
 *
 * 本文件强化「跨代判决层」的对抗维；检测 skip 的用例均以字符串字面量为输入，
 * 本文件自身无真实 skip/.only。从 cross-generation-adversarial.test.ts 拆出（结构棘轮 ≤300 行）。
 */

import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_THREAT_MAPPINGS,
  THREAT_MODELS,
  verifyAllCapabilities,
  verifyNegativeCriteria,
  type CrossGenerationCapability,
} from './cross-generation-adversarial.js';

// ---------------------------------------------------------------------------
// 威胁分类模型
// ---------------------------------------------------------------------------

describe('THREAT_MODELS', () => {
  it('covers all required threat classes', () => {
    const classes = THREAT_MODELS.map((m) => m.threatClass);
    expect(classes).toContain('privilege');
    expect(classes).toContain('data_boundary');
    expect(classes).toContain('external_input');
    expect(classes).toContain('false_green');
  });

  it('each threat model has positive and negative criteria', () => {
    for (const model of THREAT_MODELS) {
      expect(model.requiredPositiveCriteria.length).toBeGreaterThan(0);
      expect(model.requiredNegativeCriteria.length).toBeGreaterThan(0);
      expect(model.riskLevel).toMatch(/^(critical|high|medium)$/);
    }
  });

  it('privilege and false_green are critical risk', () => {
    const privilege = THREAT_MODELS.find((m) => m.threatClass === 'privilege');
    const falseGreen = THREAT_MODELS.find((m) => m.threatClass === 'false_green');
    expect(privilege?.riskLevel).toBe('critical');
    expect(falseGreen?.riskLevel).toBe('critical');
  });
});

describe('CAPABILITY_THREAT_MAPPINGS', () => {
  it('covers all five cross-generation capabilities', () => {
    const capabilities = CAPABILITY_THREAT_MAPPINGS.map((m) => m.capability);
    expect(capabilities).toContain('evidence_level');
    expect(capabilities).toContain('primary_goal_priority');
    expect(capabilities).toContain('zero_progress_stall');
    expect(capabilities).toContain('oscillation_rollback');
    expect(capabilities).toContain('false_green_detection');
  });

  it('each capability has positive and negative criteria', () => {
    for (const mapping of CAPABILITY_THREAT_MAPPINGS) {
      expect(mapping.positiveCriteria.length).toBeGreaterThan(0);
      expect(mapping.negativeCriteria.length).toBeGreaterThan(0);
      expect(mapping.threatClasses.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 负向判据强制验证
// ---------------------------------------------------------------------------

describe('verifyNegativeCriteria', () => {
  it('passes when both positive and negative criteria are provided', () => {
    const result = verifyNegativeCriteria(
      'evidence_level',
      ['合法 artifact 通过', '证据等级完整时通过'],
      ['缺 artifact 被拒', '跳级被拒', '敏感字段被拒'],
    );
    expect(result.passed).toBe(true);
    expect(result.hasPositiveCriteria).toBe(true);
    expect(result.hasNegativeCriteria).toBe(true);
    expect(result.missingNegativeCriteria).toEqual([]);
  });

  it('fails when negative criteria are missing', () => {
    const result = verifyNegativeCriteria('evidence_level', ['合法 artifact 通过'], []);
    expect(result.passed).toBe(false);
    expect(result.hasNegativeCriteria).toBe(false);
    expect(result.missingNegativeCriteria.length).toBeGreaterThan(0);
  });

  it('fails when positive criteria are missing', () => {
    const result = verifyNegativeCriteria('evidence_level', [], ['缺 artifact 被拒']);
    expect(result.passed).toBe(false);
    expect(result.hasPositiveCriteria).toBe(false);
  });

  it('fails for unknown capability', () => {
    const result = verifyNegativeCriteria('unknown' as CrossGenerationCapability, [], []);
    expect(result.passed).toBe(false);
    expect(result.missingNegativeCriteria).toContain('unknown capability');
  });

  it('detects partial negative criteria coverage', () => {
    const result = verifyNegativeCriteria(
      'zero_progress_stall',
      ['真进展继续', '不同失败被区分'],
      ['密钥明文不得进签名'],
    );
    expect(result.passed).toBe(false);
    expect(result.missingNegativeCriteria).toContain('不同失败不得被吞');
    expect(result.missingNegativeCriteria).toContain('零进展必须停止');
  });
});

describe('verifyAllCapabilities', () => {
  it('returns checks for all capabilities', () => {
    const provided = new Map<
      CrossGenerationCapability,
      { positive: readonly string[]; negative: readonly string[] }
    >();
    const results = verifyAllCapabilities(provided);
    expect(results.length).toBe(CAPABILITY_THREAT_MAPPINGS.length);
    for (const result of results) {
      expect(result.passed).toBe(false);
    }
  });

  it('passes when all capabilities have complete criteria', () => {
    const provided = new Map<
      CrossGenerationCapability,
      { positive: readonly string[]; negative: readonly string[] }
    >();
    for (const mapping of CAPABILITY_THREAT_MAPPINGS) {
      provided.set(mapping.capability, {
        positive: mapping.positiveCriteria,
        negative: mapping.negativeCriteria,
      });
    }
    const results = verifyAllCapabilities(provided);
    for (const result of results) {
      expect(result.passed).toBe(true);
    }
  });
});

