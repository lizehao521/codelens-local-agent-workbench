/**
 * P4′ 对抗与防假绿——威胁分类、负向判据强制、skip/exclude/断言弱化检测。
 *
 * 设计原则：
 * 1. 复用 L3 red-team 的 ClaimKind / ADVERSARIAL_CRITERION，不重造声明-证据匹配。
 * 2. 所有检测函数为纯函数，输入为字符串/结构，不读真实库、不用真实凭据。
 * 3. 高风险能力缺负向判据即不通过；skip/exclude/断言弱化可检测。
 *
 * 拆分说明（结构棘轮：单文件 ≤300 行）：
 * - 威胁模型与负向判据 → ./cross-generation-adversarial.threats.js
 * - 三项防假绿检测 → ./cross-generation-adversarial.false-green.js
 * 下游 `from './cross-generation-adversarial.js'` 无需改动（原样 re-export）。
 */

import {
  ADVERSARIAL_CRITERION,
  type ClaimKind,
  extractClaims,
} from '../judge/red-team.js';
import {
  detectAssertionWeakening,
  detectExclusionAnomaly,
  detectSkippedTests,
} from './cross-generation-adversarial.false-green.js';
import {
  verifyAllCapabilities,
} from './cross-generation-adversarial.threats.js';
import type {
  CrossGenerationCapability,
  ThreatClass,
} from './cross-generation-adversarial.threats.js';
import type {
  AssertionWeakeningResult,
  ExclusionAnomalyResult,
  ExclusionConfig,
  SkipDetectionResult,
} from './cross-generation-adversarial.false-green.js';
import type { NegativeCriterionCheck } from './cross-generation-adversarial.threats.js';

export * from './cross-generation-adversarial.threats.js';
export * from './cross-generation-adversarial.false-green.js';

export interface FalseGreenAssessment {
  readonly skipDetection: SkipDetectionResult;
  readonly exclusionAnomaly: ExclusionAnomalyResult;
  readonly assertionWeakening: AssertionWeakeningResult;
  readonly overallRisk: 'critical' | 'high' | 'medium' | 'none';
  readonly passed: boolean;
}

export function assessFalseGreen(
  testSource: string,
  baselineCount: number,
  actualCount: number,
  config: ExclusionConfig = {},
  diffSource?: string,
): FalseGreenAssessment {
  const skipDetection = detectSkippedTests(testSource);
  const exclusionAnomaly = detectExclusionAnomaly(baselineCount, actualCount, config);
  const assertionWeakening = detectAssertionWeakening(diffSource ?? testSource);

  const risks = [skipDetection.riskLevel, exclusionAnomaly.hasRisk ? 'high' : 'none', assertionWeakening.riskLevel];
  const overallRisk = risks.includes('critical')
    ? 'critical'
    : risks.includes('high')
      ? 'high'
      : risks.includes('medium')
        ? 'medium'
        : 'none';

  const passed = !skipDetection.hasRisk && !exclusionAnomaly.hasRisk && !assertionWeakening.hasRisk;

  return {
    skipDetection,
    exclusionAnomaly,
    assertionWeakening,
    overallRisk,
    passed,
  };
}

// ---------------------------------------------------------------------------
// 跨代对抗判决
// ---------------------------------------------------------------------------

export interface CrossGenerationAdversarialVerdict {
  readonly capabilityChecks: readonly NegativeCriterionCheck[];
  readonly falseGreenAssessment: FalseGreenAssessment;
  readonly overallPassed: boolean;
  readonly failureReasons: readonly string[];
}

export function evaluateCrossGenerationAdversarial(
  providedCriteria: ReadonlyMap<CrossGenerationCapability, { positive: readonly string[]; negative: readonly string[] }>,
  testSource: string,
  baselineCount: number,
  actualCount: number,
  config: ExclusionConfig = {},
  diffSource?: string,
): CrossGenerationAdversarialVerdict {
  const capabilityChecks = verifyAllCapabilities(providedCriteria);
  const falseGreenAssessment = assessFalseGreen(testSource, baselineCount, actualCount, config, diffSource);

  const failureReasons: string[] = [];

  for (const check of capabilityChecks) {
    if (!check.passed) {
      if (!check.hasNegativeCriteria) {
        failureReasons.push(`[${check.capability}] 缺负向判据: ${check.missingNegativeCriteria.join('; ')}`);
      }
      if (!check.hasPositiveCriteria) {
        failureReasons.push(`[${check.capability}] 缺正向判据`);
      }
    }
  }

  if (falseGreenAssessment.skipDetection.hasRisk) {
    failureReasons.push(
      `[false_green] skip/.only 检测命中: ${falseGreenAssessment.skipDetection.patterns.map((p) => `${p.kind}@${p.line}`).join(', ')}`,
    );
  }
  if (falseGreenAssessment.exclusionAnomaly.hasRisk) {
    failureReasons.push(`[false_green] 测试集合异常缩减: ${falseGreenAssessment.exclusionAnomaly.reason}`);
  }
  if (falseGreenAssessment.assertionWeakening.hasRisk) {
    failureReasons.push(
      `[false_green] 断言弱化检测命中: ${falseGreenAssessment.assertionWeakening.patterns.map((p) => `${p.kind}@${p.line}`).join(', ')}`,
    );
  }

  const overallPassed = capabilityChecks.every((c) => c.passed) && falseGreenAssessment.passed;

  return {
    capabilityChecks,
    falseGreenAssessment,
    overallPassed,
    failureReasons,
  };
}

// ---------------------------------------------------------------------------
// 复用 L3 red-team 的声明-证据匹配（不重造）
// ---------------------------------------------------------------------------

export { ADVERSARIAL_CRITERION, extractClaims };
export type { ClaimKind };

// ---------------------------------------------------------------------------
// 风险分级依据
// ---------------------------------------------------------------------------

export const RISK_LEVEL_JUSTIFICATION: Readonly<Record<ThreatClass, string>> = {
  privilege: '权限突破可直接导致未授权数据访问或系统控制，风险最高',
  data_boundary: '数据边界破坏可导致注入、泄露或篡改，风险高',
  external_input: '外部输入不可信，恶意负载可触发注入或 DoS，风险高',
  false_green: '假绿使判决层自身失效，所有其他防护被绕过，风险最高',
} as const;
