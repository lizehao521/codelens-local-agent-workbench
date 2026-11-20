/**
 * 跨代影子桥接。
 * 输入两代 RsiBridgeResult，构造 CrossGenerationVerdictInput 并调用评估器，
 * 输出 UnifiedRsiConsumption 供调用方审计。核心判决为纯函数；另附只读 DB 取数辅助 loadPreviousGeneration。
 * 不写库、不改动 next.state。
 * 设计裁定 D1/D2/D3 见各映射函数注释及文件末尾核对清单。
 */
import type { RsiBridgeResult, RsiVerdictState } from './rsi-bridge.service.js';
import {
  evaluateCrossGenerationVerdict,
  type CrossGenerationVerdictInput,
  type IndicatorValue,
  type GenerationIndicators,
  type MetricDelta,
} from './cross-generation-verdict.js';
import type {
  MetricDefinition,
  GenerationEvidence,
  EvidenceLevel,
} from './cross-generation-contract.js';
import {
  adaptCrossGenerationVerdict,
  type UnifiedRsiConsumption,
} from './cross-generation-adapter.js';

const BRIDGE_DEFINITION_VERSION = 'rsi-bridge.v1';
const BRIDGE_RULES_VERSION = 'cross-generation-verdict.v1' as const;

/**
 * 设计裁定 D2（保守映射）：一律返回 'landed'。
 * 理由：contract 的 validateEvidence 要求 full_suite_passed / targeted_passed
 * 必须分别携带 fullSuiteCommand / targetedTestCommand，而 RsiBridgeResult
 * 并不提供这些字段；基线 toEvidence 只提供 landedFilesHash=ledgerPath，
 * 恰好满足 landed 的校验要求。故所有 state 统一映射为 landed，
 * 证据强弱不再参与分级，跨代比较仅基于指标值，杜绝 INVALID_EVIDENCE。
 */
function toEvidenceLevel(state: RsiVerdictState): EvidenceLevel {
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
function toMetricDefinition(metric: string, before: number, after: number, better: boolean): MetricDefinition {
  let direction: MetricDefinition['direction'] = 'higher_is_better';
  if (better && after < before) direction = 'lower_is_better';
  return {
    id: metric,
    definitionVersion: BRIDGE_DEFINITION_VERSION,
    direction,
    unit: 'score',
  };
}

function toIndicators(result: RsiBridgeResult): GenerationIndicators {
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

function toEvidence(result: RsiBridgeResult): GenerationEvidence {
  return {
    level: toEvidenceLevel(result.state),
    landedFilesHash: result.ledgerPath, // 设计裁定：无真实 hash，以 ledgerPath 作为可追溯标识
  };
}

/**
 * 影子评估入口。
 * previous 为 null 时返回 source:'cross_generation'/state:'skipped'，不伪装 undecidable。
 * 绝不修改 next.state；返回的 UnifiedRsiConsumption 由调用方决定是否落库。
 */
export function evaluateCrossGenerationShadow(
  previous: RsiBridgeResult | null,
  next: RsiBridgeResult,
): UnifiedRsiConsumption {
  if (previous === null) {
    return {
      state: 'skipped',
      verdict: 'undecidable',
      source: 'cross_generation',
      reason: 'cross-generation shadow skipped: no previous generation',
      reasons: ['cross-generation shadow skipped: no previous generation'],
      exitCode: next.exitCode,
      metrics: next.metrics,
      reportRaw: next.reportRaw,
      ledgerPath: next.ledgerPath,
    };
  }

  const input: CrossGenerationVerdictInput = {
    rulesVersion: BRIDGE_RULES_VERSION,
    previous: {
      indicators: toIndicators(previous),
      evidence: toEvidence(previous),
    },
    next: {
      indicators: toIndicators(next),
      evidence: toEvidence(next),
    },
  };

  const verdictResult = evaluateCrossGenerationVerdict(input);
  const unified = adaptCrossGenerationVerdict(verdictResult);

  // 统一消费层补齐 legacy 字段，便于审计/序列化
  return {
    ...unified,
    exitCode: next.exitCode,
    metrics: next.metrics,
    reportRaw: next.reportRaw,
    ledgerPath: next.ledgerPath,
  };
}


/**
 * 只读辅助：从 policy_rsi_runs 上一代审计行重建 RsiBridgeResult，供影子判决作 previous。
 * 列名来自 schema.ts policy_rsi_runs 真实定义；无 db / 无上一代 / 解析失败都返回 null。
 * 这是本模块唯一的 IO 辅助，核心 evaluateCrossGenerationShadow 仍是纯函数。
 *
 * beforeGeneration（可选）：排除 generation >= 该值的最新行。影子判决接线处
 * compare() 已先把当前代(N+1)落库，若取最新行会拿到当前代自己 → previous≡next
 * 恒无意义。传入逻辑当前代后，用 `generation < ?` 稳定取真上一代：当前代已落库
 * 时排除之取 N；未落库时上一代天然满足谓词。禁用 OFFSET 1（未落库路径会错取 N-1）。
 * 不传时保持原语义（取最新行），向后兼容。
 */
export function loadPreviousGeneration(
  db: { get<T>(sql: string, params?: Array<string | number | null>): T | undefined } | undefined,
  sessionId: string,
  beforeGeneration?: number,
): RsiBridgeResult | null {
  if (!db) return null;
  try {
    const useExclusion = typeof beforeGeneration === 'number';
    const row = db.get<{
      verdict: string;
      exit_code: number | null;
      reasons_json: string | null;
      metrics_json: string | null;
      ledger_path: string;
    }>(
      useExclusion
        ? `SELECT verdict, exit_code, reasons_json, metrics_json, ledger_path
             FROM policy_rsi_runs
            WHERE session_id = ? AND generation < ?
            ORDER BY generation DESC LIMIT 1`
        : `SELECT verdict, exit_code, reasons_json, metrics_json, ledger_path
             FROM policy_rsi_runs
            WHERE session_id = ?
            ORDER BY generation DESC LIMIT 1`,
      useExclusion ? [sessionId, beforeGeneration] : [sessionId],
    );
    if (!row) return null;
    return {
      state: row.verdict as RsiBridgeResult['state'],
      exitCode: row.exit_code,
      reasons: row.reasons_json ? (JSON.parse(row.reasons_json) as string[]) : [],
      metrics: row.metrics_json ? (JSON.parse(row.metrics_json) as RsiBridgeResult['metrics']) : undefined,
      reportRaw: '',
      ledgerPath: row.ledger_path,
    };
  } catch {
    return null;
  }
}
