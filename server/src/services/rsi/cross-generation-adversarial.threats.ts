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

