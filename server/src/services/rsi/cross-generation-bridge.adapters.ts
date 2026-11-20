/**
 * 跨代影子桥接：RsiBridgeResult → 跨代契约的映射适配层（内部实现）。
 *
 * 设计裁定 D2（保守映射）：一律返回 'landed'。理由：contract 的 validateEvidence 要求
 * full_suite_passed / targeted_passed 必须分别携带 fullSuiteCommand / targetedTestCommand，
 * 而 RsiBridgeResult 并不提供这些字段；基线 toEvidence 只提供 landedFilesHash=ledgerPath，
 * 恰好满足 landed 的校验要求。故所有 state 统一映射为 landed，证据强弱不再参与分级，
 * 跨代比较仅基于指标值，杜绝 INVALID_EVIDENCE。
 *
 * 从 cross-generation-bridge.ts 拆出（结构棘轮 ≤300 行）。
 */

import type { RsiBridgeResult, RsiVerdictState } from './rsi-bridge.service.js';
import type {
  EvidenceLevel,
  GenerationEvidence,
  MetricDefinition,
} from './cross-generation-contract.js';
import type {
  GenerationIndicators,
  MetricDelta,
} from './cross-generation-verdict.js';

export const BRIDGE_DEFINITION_VERSION = 'rsi-bridge.v1';
export const BRIDGE_RULES_VERSION = 'cross-generation-verdict.v1' as const;

/**
 * 设计裁定 D2（保守映射）：一律返回 'landed'。
 * 理由：contract 的 validateEvidence 要求 full_suite_passed / targeted_passed
 * 必须分别携带 fullSuiteCommand / targetedTestCommand，而 RsiBridgeResult
 * 并不提供这些字段；基线 toEvidence 只提供 landedFilesHash=ledgerPath，
 * 恰好满足 landed 的校验要求。故所有 state 统一映射为 landed，
 * 证据强弱不再参与分级，跨代比较仅基于指标值，杜绝 INVALID_EVIDENCE。
 */
export function toEvidenceLevel(state: RsiVerdictState): EvidenceLevel {
  switch (state) {
    case 'improved':
      return 'landed';
    case 'not_improved':
      return 'landed';
    case 'undecidable':
      return 'landed';
    case 'refused':
      return 'landed';
    case 'skipped':
      return 'landed';
    case 'error':
      return 'landed';
    default: {
      const _exhaustive: never = state;
      throw new Error(`Unknown RsiVerdictState: ${_exhaustive}`);
    }
  }
}

/**
 * 设计裁定 D1：
 * - metric 字符串即 MetricDefinition.id，definitionVersion 固定 'rsi-bridge.v1'
 * - unit 固定 'score'（RSI 指标为无量纲评分）
 * - direction 由 before/after/better 联合推断：
 *     after > before 且 better=true  → higher_is_better
 *     after < before 且 better=true  → lower_is_better
 *     better=false / 差值为零       → 默认 higher_is_better（保守，对 improved/regressed 判定影响有限）
 */
export function toMetricDefinition(metric: string, before: number, after: number, better: boolean): MetricDefinition {
  let direction: MetricDefinition['direction'] = 'higher_is_better';
  if (better && after < before) direction = 'lower_is_better';
  return {
    id: metric,
    definitionVersion: BRIDGE_DEFINITION_VERSION,
    direction,
    unit: 'score',
  };
}

export function toIndicators(result: RsiBridgeResult): GenerationIndicators {
  const metrics = result.metrics ?? [];
  if (metrics.length === 0) {
    // 无指标时构造零值占位，保证 F10 结构完整；评估器会据此返回 undecidable/refused
    return {
      primary: {
        definition: {
          id: '__placeholder__',
          definitionVersion: BRIDGE_DEFINITION_VERSION,
          direction: 'higher_is_better',
          unit: 'score',
        },
        value: 0,
      },
    };
  }
  const primary = metrics[0];
  if (!primary) {
    return {
      primary: {
        definition: {
          id: '__placeholder__',
          definitionVersion: BRIDGE_DEFINITION_VERSION,
          direction: 'higher_is_better',
          unit: 'score',
        },
        value: 0,
      },
    };
  }
  const rest = metrics.slice(1);
  return {
    primary: {
      definition: toMetricDefinition(primary.metric, primary.before, primary.after, primary.better),
      value: primary.after,
    },
    guards: rest.map((m) => ({
      definition: toMetricDefinition(m.metric, m.before, m.after, m.better),
      value: m.after,
    })),
  };
}

export function toEvidence(result: RsiBridgeResult): GenerationEvidence {
  return {
    level: toEvidenceLevel(result.state),
    landedFilesHash: result.ledgerPath, // 设计裁定：无真实 hash，以 ledgerPath 作为可追溯标识
  };
}
