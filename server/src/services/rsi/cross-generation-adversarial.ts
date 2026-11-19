/**
 * P4′ 对抗与防假绿——威胁分类、负向判据强制、skip/exclude/断言弱化检测。
 *
 * 设计原则：
 * 1. 复用 L3 red-team 的 ClaimKind / ADVERSARIAL_CRITERION，不重造声明-证据匹配。
 * 2. 所有检测函数为纯函数，输入为字符串/结构，不读真实库、不用真实凭据。
 * 3. 高风险能力缺负向判据即不通过；skip/exclude/断言弱化可检测。
 */

import {
  ADVERSARIAL_CRITERION,
  type ClaimKind,
  extractClaims,
} from '../judge/red-team.js';
import type { EvidenceLevel } from './cross-generation-contract.js';

// ---------------------------------------------------------------------------
// 威胁分类模型
// ---------------------------------------------------------------------------

export type ThreatClass =
  | 'privilege'
  | 'data_boundary'
  | 'external_input'
  | 'false_green';

export interface ThreatModel {
  readonly threatClass: ThreatClass;
  readonly description: string;
  readonly requiredPositiveCriteria: readonly string[];
  readonly requiredNegativeCriteria: readonly string[];
  readonly riskLevel: 'critical' | 'high' | 'medium';
}

export const THREAT_MODELS: readonly ThreatModel[] = [
  {
    threatClass: 'privilege',
    description: '权限边界：未授权访问、越权操作、凭据泄露',
    requiredPositiveCriteria: ['合法权限通过', '授权操作成功'],
    requiredNegativeCriteria: ['未授权访问被拒', '越权操作被拒', '敏感字段不泄露'],
    riskLevel: 'critical',
  },
  {
    threatClass: 'data_boundary',
    description: '数据边界：输入验证、输出过滤、数据完整性',
    requiredPositiveCriteria: ['合法数据通过', '边界值正确处理'],
    requiredNegativeCriteria: ['非法输入被拒', '注入攻击被阻断', '数据篡改被检测'],
    riskLevel: 'high',
  },
  {
    threatClass: 'external_input',
    description: '外部输入：不可信来源、恶意负载、协议异常',
    requiredPositiveCriteria: ['合法外部输入正常处理'],
    requiredNegativeCriteria: ['恶意负载被隔离', '协议异常被处理', '超时/资源耗尽被限制'],
    riskLevel: 'high',
  },
  {
    threatClass: 'false_green',
    description: '防假绿：测试跳过、集合缩减、断言弱化',
    requiredPositiveCriteria: ['完整测试集合通过', '严格断言通过'],
    requiredNegativeCriteria: ['skip/.only 被检测', '测试集合异常缩减被检测', '断言弱化被检测'],
    riskLevel: 'critical',
  },
] as const;

// ---------------------------------------------------------------------------
// 跨代判决能力威胁映射
// ---------------------------------------------------------------------------

export type CrossGenerationCapability =
  | 'evidence_level'
  | 'primary_goal_priority'
  | 'zero_progress_stall'
  | 'oscillation_rollback'
  | 'false_green_detection';

export interface CapabilityThreatMapping {
  readonly capability: CrossGenerationCapability;
  readonly threatClasses: readonly ThreatClass[];
  readonly positiveCriteria: readonly string[];
  readonly negativeCriteria: readonly string[];
}

export const CAPABILITY_THREAT_MAPPINGS: readonly CapabilityThreatMapping[] = [
  {
    capability: 'evidence_level',
    threatClasses: ['data_boundary', 'privilege'],
    positiveCriteria: ['合法 artifact 通过', '证据等级完整时通过'],
    negativeCriteria: ['缺 artifact 被拒', '跳级被拒', '敏感字段被拒'],
  },
  {
    capability: 'primary_goal_priority',
    threatClasses: ['data_boundary'],
    positiveCriteria: ['主目标改善判 improved'],
    negativeCriteria: ['辅助指标改善但主目标失败必须被拒', '主目标退化不得被辅助抵消'],
  },
  {
    capability: 'zero_progress_stall',
    threatClasses: ['data_boundary', 'privilege'],
    positiveCriteria: ['真进展继续', '不同失败被区分'],
    negativeCriteria: ['密钥明文不得进签名', '不同失败不得被吞', '零进展必须停止'],
  },
  {
    capability: 'oscillation_rollback',
    threatClasses: ['data_boundary'],
    positiveCriteria: ['净改善不判震荡', '已验证快照可选'],
    negativeCriteria: ['往返无净改善必判 oscillating', '未验证快照不得选'],
  },
  {
    capability: 'false_green_detection',
    threatClasses: ['false_green'],
    positiveCriteria: ['完整测试集合通过', '严格断言通过'],
    negativeCriteria: ['skip/todo/.only/xit/xdescribe 出现即判风险', '测试集合异常缩减超阈值即判风险', '断言弱化模式可检测'],
  },
] as const;

// ---------------------------------------------------------------------------
// 负向判据强制验证
// ---------------------------------------------------------------------------

export interface NegativeCriterionCheck {
  readonly capability: CrossGenerationCapability;
  readonly hasPositiveCriteria: boolean;
  readonly hasNegativeCriteria: boolean;
  readonly missingNegativeCriteria: readonly string[];
  readonly passed: boolean;
}

export function verifyNegativeCriteria(
  capability: CrossGenerationCapability,
  providedPositive: readonly string[],
  providedNegative: readonly string[],
): NegativeCriterionCheck {
  const mapping = CAPABILITY_THREAT_MAPPINGS.find((m) => m.capability === capability);
  if (!mapping) {
    return {
      capability,
      hasPositiveCriteria: false,
      hasNegativeCriteria: false,
      missingNegativeCriteria: ['unknown capability'],
      passed: false,
    };
  }

  const hasPositiveCriteria = mapping.positiveCriteria.every((c) =>
    providedPositive.some((p) => p.includes(c) || c.includes(p)),
  );
  const missingNegativeCriteria = mapping.negativeCriteria.filter(
    (c) => !providedNegative.some((n) => n.includes(c) || c.includes(n)),
  );
  const hasNegativeCriteria = missingNegativeCriteria.length === 0;

  return {
    capability,
    hasPositiveCriteria,
    hasNegativeCriteria,
    missingNegativeCriteria,
    passed: hasPositiveCriteria && hasNegativeCriteria,
  };
}

export function verifyAllCapabilities(
  provided: ReadonlyMap<CrossGenerationCapability, { positive: readonly string[]; negative: readonly string[] }>,
): readonly NegativeCriterionCheck[] {
  return CAPABILITY_THREAT_MAPPINGS.map((mapping) => {
    const input = provided.get(mapping.capability) ?? { positive: [], negative: [] };
    return verifyNegativeCriteria(mapping.capability, input.positive, input.negative);
  });
}

// ---------------------------------------------------------------------------
// 防假绿检测：skip/todo/.only
// ---------------------------------------------------------------------------

export interface SkipDetectionResult {
  readonly hasRisk: boolean;
  readonly patterns: readonly SkipPattern[];
  readonly riskLevel: 'critical' | 'high' | 'medium' | 'none';
}

export interface SkipPattern {
  readonly kind: 'skip' | 'todo' | 'only' | 'xit' | 'xdescribe' | 'xtest';
  readonly line: number;
  readonly snippet: string;
}

const SKIP_PATTERNS: readonly { kind: SkipPattern['kind']; regex: RegExp }[] = [
  { kind: 'skip', regex: /\b(?:it|test|describe)\.skip\s*\(/g },
  { kind: 'todo', regex: /\b(?:it|test)\.todo\s*\(/g },
  { kind: 'only', regex: /\b(?:it|test|describe)\.only\s*\(/g },
  { kind: 'xit', regex: /\bxit\s*\(/g },
  { kind: 'xdescribe', regex: /\bxdescribe\s*\(/g },
  { kind: 'xtest', regex: /\bxtest\s*\(/g },
] as const;

export function detectSkippedTests(testSource: string): SkipDetectionResult {
  const lines = testSource.split('\n');
  const patterns: SkipPattern[] = [];

  for (const { kind, regex } of SKIP_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        patterns.push({
          kind,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
        });
      }
    }
  }

  const hasRisk = patterns.length > 0;
  const riskLevel = hasRisk ? (patterns.some((p) => p.kind === 'only') ? 'critical' : 'high') : 'none';

  return { hasRisk, patterns, riskLevel };
}

// ---------------------------------------------------------------------------
// 防假绿检测：测试集合异常缩减
// ---------------------------------------------------------------------------

export interface ExclusionAnomalyResult {
  readonly hasRisk: boolean;
  readonly baselineCount: number;
  readonly actualCount: number;
  readonly reductionRatio: number;
  readonly threshold: number;
  readonly excludedPatterns: readonly string[];
  readonly reason: string;
}

export interface ExclusionConfig {
  readonly threshold?: number;
  readonly excludePatterns?: readonly string[];
  readonly testFiles?: readonly string[];
}

export function detectExclusionAnomaly(
  baselineCount: number,
  actualCount: number,
  config: ExclusionConfig = {},
): ExclusionAnomalyResult {
  const threshold = config.threshold ?? 0.1;
  const excludedPatterns = config.excludePatterns ?? [];
  const reduction = baselineCount - actualCount;
  const reductionRatio = baselineCount > 0 ? reduction / baselineCount : 0;

  const hasExclusionPatterns = excludedPatterns.length > 0;
  const hasSignificantReduction = reductionRatio > threshold;
  const hasRisk = hasSignificantReduction || (hasExclusionPatterns && reduction > 0);

  let reason = '';
  if (hasSignificantReduction) {
    reason = `测试集合缩减 ${(reductionRatio * 100).toFixed(1)}% 超过阈值 ${(threshold * 100).toFixed(1)}%`;
  } else if (hasExclusionPatterns && reduction > 0) {
    reason = `配置排除模式导致测试减少: ${excludedPatterns.join(', ')}`;
  } else if (reduction > 0) {
    reason = `测试集合缩减 ${(reductionRatio * 100).toFixed(1)}% 在阈值内`;
  } else {
    reason = '测试集合无缩减';
  }

  return {
    hasRisk,
    baselineCount,
    actualCount,
    reductionRatio,
    threshold,
    excludedPatterns,
    reason,
  };
}

// ---------------------------------------------------------------------------
// 防假绿检测：断言弱化
// ---------------------------------------------------------------------------

export interface AssertionWeakeningResult {
  readonly hasRisk: boolean;
  readonly patterns: readonly AssertionWeakeningPattern[];
  readonly riskLevel: 'critical' | 'high' | 'medium' | 'none';
}

export interface AssertionWeakeningPattern {
  readonly kind: 'toEqual_to_toContain' | 'strict_to_loose' | 'assertion_removed' | 'toBe_to_toBeTruthy' | 'toHaveLength_to_toBeGreaterThan';
  readonly line: number;
  readonly before: string;
  readonly after: string;
}

const ASSERTION_WEAKENING_RULES: readonly {
  kind: AssertionWeakeningPattern['kind'];
  before: RegExp;
  after: RegExp;
}[] = [
  {
    kind: 'toEqual_to_toContain',
    before: /\.toEqual\s*\(/,
    after: /\.toContain\s*\(/,
  },
  {
    kind: 'strict_to_loose',
    before: /\.toBe\s*\(/,
    after: /\.toEqual\s*\(/,
  },
  {
    kind: 'toBe_to_toBeTruthy',
    before: /\.toBe\s*\(/,
    after: /\.toBeTruthy\s*\(/,
  },
  {
    kind: 'toHaveLength_to_toBeGreaterThan',
    before: /\.toHaveLength\s*\(/,
    after: /\.toBeGreaterThan\s*\(/,
  },
] as const;

export function detectAssertionWeakening(diffOrSource: string): AssertionWeakeningResult {
  const lines = diffOrSource.split('\n');
  const patterns: AssertionWeakeningPattern[] = [];

  // 检测 diff 格式：- 旧行 / + 新行
  const removedLines: { line: number; content: string }[] = [];
  const addedLines: { line: number; content: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.startsWith('-') && !line.startsWith('---')) {
      removedLines.push({ line: i + 1, content: line.slice(1) });
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines.push({ line: i + 1, content: line.slice(1) });
    }
  }

  // 检测断言替换
  for (const rule of ASSERTION_WEAKENING_RULES) {
    for (const removed of removedLines) {
      if (rule.before.test(removed.content)) {
        for (const added of addedLines) {
          if (rule.after.test(added.content)) {
            patterns.push({
              kind: rule.kind,
              line: removed.line,
              before: removed.content.trim().slice(0, 120),
              after: added.content.trim().slice(0, 120),
            });
          }
        }
      }
    }
  }

  // 检测断言删除（有删除行但无对应添加行）
  const assertionRegex = /\b(?:expect|assert)\s*\(/;
  for (const removed of removedLines) {
    if (assertionRegex.test(removed.content)) {
      const hasCorrespondingAdd = addedLines.some(
        (added) => Math.abs(added.line - removed.line) <= 3 && assertionRegex.test(added.content),
      );
      if (!hasCorrespondingAdd) {
        patterns.push({
          kind: 'assertion_removed',
          line: removed.line,
          before: removed.content.trim().slice(0, 120),
          after: '',
        });
      }
    }
  }

  // 检测非 diff 源码中的弱化模式（直接比较）
  if (patterns.length === 0 && removedLines.length === 0 && addedLines.length === 0) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      // 检测 toBeTruthy 替代严格比较
      if (/\.toBeTruthy\s*\(\s*\)/.test(line) && /(?:===|!==|toBe|toEqual)/.test(line)) {
        patterns.push({
          kind: 'toBe_to_toBeTruthy',
          line: i + 1,
          before: '',
          after: line.trim().slice(0, 120),
        });
      }
    }
  }

  const hasRisk = patterns.length > 0;
  const riskLevel = hasRisk
    ? patterns.some((p) => p.kind === 'assertion_removed')
      ? 'critical'
      : 'high'
    : 'none';

  return { hasRisk, patterns, riskLevel };
}

// ---------------------------------------------------------------------------
// 综合防假绿评估
// ---------------------------------------------------------------------------

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
