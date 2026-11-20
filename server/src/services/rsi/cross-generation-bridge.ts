/**
 * 跨代影子桥接。
 * 输入两代 RsiBridgeResult，构造 CrossGenerationVerdictInput 并调用评估器，
 * 输出 UnifiedRsiConsumption 供调用方审计。核心判决为纯函数；另附只读 DB 取数辅助 loadPreviousGeneration。
 * 不写库、不改动 next.state。
 * 设计裁定 D1/D2/D3 见各映射函数注释及文件末尾核对清单。
 *
 * 拆分说明（结构棘轮：单文件 ≤300 行）：映射适配层 → ./cross-generation-bridge.adapters.js。
 */

import type { RsiBridgeResult } from './rsi-bridge.service.js';
import type { TraceSpanKind } from '../observability/trace.service.js';
import {
  evaluateCrossGenerationVerdict,
  type CrossGenerationVerdictInput,
} from './cross-generation-verdict.js';
import {
  adaptCrossGenerationVerdict,
  type UnifiedRsiConsumption,
} from './cross-generation-adapter.js';
import { buildConsistencyShadow, type DiffCoverage } from './cross-generation-consistency.js';
import {
  collectFailureEvidence,
  upsertFailureEvidence,
  loadGenerationFailure,
  type EvidenceDb,
} from './generation-evidence.js';
import {
  collectDiffEvidence,
  isInv1Eligible,
  upsertDiffEvidence,
  buildDiffGuard,
} from './generation-diff.js';
import {
  BRIDGE_RULES_VERSION,
  toEvidence,
  toIndicators,
} from './cross-generation-bridge.adapters.js';

export {
  BRIDGE_DEFINITION_VERSION,
  BRIDGE_RULES_VERSION,
  toEvidenceLevel,
  toMetricDefinition,
  toIndicators,
  toEvidence,
} from './cross-generation-bridge.adapters.js';

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

/**
 * 跨代影子判决审计（P0 接线收敛辅助）。
 * 把 agent-loop 中的影子判决 try/catch 原样下推至此，让 agent-loop 只需 +2 行
 * （1 import + 1 调用）即可具备等价接线，避开其 1548/1550 行数棘轮。
 * 只经 recordSpan 回调试记轨迹：不改 result.state、不写 policy_rsi_runs、不阻断 π、不抛错。
 */
interface RecordShadowAuditParams {
  db: {
    get<T>(sql: string, params?: Array<string | number | null>): T | undefined;
    all?<T>(sql: string, params?: Array<string | number | null>): T[];
  } | undefined;
  sessionId: string;
  result: RsiBridgeResult;
  traceId: string | null | undefined;
  recordSpan: (
    traceId: string | null | undefined,
    span: {
      kind: TraceSpanKind;
      name: string;
      status?: 'ok' | 'error';
      detail?: string;
      durationMs?: number;
    },
  ) => void;
}

export function recordShadowAudit({
  db,
  sessionId,
  result,
  traceId,
  recordSpan,
}: RecordShadowAuditParams): void {
  try {
    // 一次查询同时取当前代（generation）与其上一代（prev_generation 列）。
    // compare() 已把当前代落库，故最新行即当前代；prev_generation 即其上一代 generation。
    const row = db?.get<{ cg: number; pg: number | null }>(
      `SELECT generation AS cg, prev_generation AS pg
         FROM policy_rsi_runs
        WHERE session_id = ?
        ORDER BY generation DESC LIMIT 1`,
      [sessionId],
    );
    const cg = row?.cg ?? null;
    const pg = row?.pg ?? null;
    const previous = loadPreviousGeneration(db, sessionId, cg ?? 0);
    const shadow = evaluateCrossGenerationShadow(previous, result);
    // failure 第一阶段（codelens exp168b 修正）：采集当前代 tool_calls 失败证据并幂等
    // 落 rsi_generation_evidence。只读、不阻断；db 能力不足时内部自动降级为空证据。
    // ★这只让 evaluateStall 判定 1（signature_repeated）首次可用，受益的是 INV-3；
    //   对 INV-2 是负向（其条件含 !stalled），不构成解锁。
    const evidenceDb = db as unknown as EvidenceDb | undefined;
    let diffGuard: ReturnType<typeof buildDiffGuard> | null = null;
    let diffCoverage: DiffCoverage | undefined;
    let inv1 = false;
    if (evidenceDb) {
      upsertFailureEvidence(evidenceDb, sessionId, collectFailureEvidence(evidenceDb, sessionId));
      // diff 乙阶段：从 tool_calls.args_json 操作级重建（只通数据，不解封 INV-1）。
      // 采集与 failure 共用同一窗口；upsert 幂等；内部任何异常静默降级为空证据。
      const diff = collectDiffEvidence(evidenceDb, sessionId);
      upsertDiffEvidence(evidenceDb, sessionId, diff);
      diffCoverage = diff.status;
      diffGuard = buildDiffGuard(diff, shadow.verdict);
      inv1 = isInv1Eligible(diff, shadow.verdict);
    }
    // B 项：只读拉多代行重建一致性阴影视图（不写库、不阻断）。查询失败按空集降级，
    // 不拖垮影子判决本身。明细上限 DETAIL_MAX=500，超限时省略此键保原 7 键完整。
    const rows: Array<{ generation: number; ledger_path: string | null }> =
      typeof db?.all === 'function'
        ? db.all<{ generation: number; ledger_path: string | null }>(
            'SELECT generation, ledger_path FROM policy_rsi_runs WHERE session_id = ? ORDER BY generation ASC',
            [sessionId],
          )
        : [];
    const consistencyShadow = buildConsistencyShadow(
      rows.map((r) => ({
        generation: r.generation,
        ledgerPath: r.ledger_path,
        failure: evidenceDb ? loadGenerationFailure(evidenceDb, sessionId, r.generation) : null,
      })),
      shadow.verdict,
      diffCoverage,
      inv1,
    );
    const detail = JSON.stringify({
      state: shadow.state,
      verdict: shadow.verdict,
      source: shadow.source,
      reason: shadow.reason,
      hadPrevious: previous !== null,
      pg,
      cg,
      consistencyShadow,
      ...(diffGuard !== null ? { diffGuard } : {}),
    });
    recordSpan(traceId, {
      kind: 'judge',
      name: `跨代影子判决`,
      status: 'ok',
      detail: detail.length <= 500
        ? detail
        : JSON.stringify({ state: shadow.state, verdict: shadow.verdict, source: shadow.source, reason: shadow.reason, hadPrevious: previous !== null, pg, cg }),
    });
  } catch (err) {
    recordSpan(traceId, {
      kind: 'judge',
      name: `跨代影子判决`,
      status: 'error',
      detail: `shadow failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
