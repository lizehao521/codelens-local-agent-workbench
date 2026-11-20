/**
 * P8′ 跨代判决稳定性/一致性交叉验证器（旁路纯函数）。
 *
 * 职责：检测同一次输入里「跨代 verdict」与「停滞/振荡/回退」结论之间的逻辑矛盾，
 * 输出可审计的 violation 列表。不改任何既有模块导出、不写库、不阻断 RSI/π 闭环。
 *
 * 设计来源：exp158 与 codelens 融合讨论裁定。字段全部对照真实 interface：
 *   CrossGenerationVerdictResult(verdict.ts) / StallVerdict(stall.ts) /
 *   OscillationAnalysis、RollbackDecision(oscillation.ts) / DiffInput(stall.ts)。
 * 复用 isZeroEffectiveDiff(stall.ts)，不重新实现零 diff 判定。
 *
 * 不变量（可证伪）：
 *   INV-1 contradiction：verdict=improved 且零有效 diff —— 无代码变更却宣称改进。
 *   INV-2 contradiction：verdict=not_improved ∧ 回退决策(rollback) ∧ stall 无停滞 reason
 *                        —— 有回退信号但判决既非 undecidable/refused 也无停滞佐证。
 *   INV-3 warning      ：verdict=improved ∧ stall.stopped —— 单代改进与多代停滞可共存，仅警示。
 *   INV-4（仅前半）    ：verdict=refused 时跳过 INV-1/INV-3（拒判不是证据断言）。
 *                        后半「证据充分却 refused」因真实类型无「证据充分」字段，按裁定不实现。
 */
import type { CrossGenerationVerdictResult } from './cross-generation-verdict.js';
import type { StallVerdict, DiffInput } from './cross-generation-stall.js';
import { isZeroEffectiveDiff, evaluateStall, type GenerationRecord } from './cross-generation-stall.js';
import type { OscillationAnalysis, RollbackDecision } from './cross-generation-oscillation.js';

export type ConsistencySeverity = 'contradiction' | 'warning';

export interface ConsistencyViolation {
  readonly invariant: string;
  readonly severity: ConsistencySeverity;
  readonly detail: string;
}

export interface ConsistencyInput {
  readonly verdict: CrossGenerationVerdictResult;
  readonly stall: StallVerdict;
  readonly oscillation: OscillationAnalysis;
  readonly rollback: RollbackDecision;
  readonly latestDiff: DiffInput;
}

export interface ConsistencyReport {
  /** 无 contradiction 级违规即为 true；warning 不置 false。 */
  readonly consistent: boolean;
  readonly violations: readonly ConsistencyViolation[];
}

/** stall 是否给出停滞类佐证：'none' 表示无停滞，其余 STALL_REASONS 均为停滞。 */
function hasStallReason(stall: StallVerdict): boolean {
  return stall.reason !== 'none' || stall.stopped;
}

/** rollback 是否产出回退类决策。真实值域：'rollback' | 'no_rollback' | 'undecidable'。 */
function isRollbackAction(rollback: RollbackDecision): boolean {
  return rollback.action === 'rollback';
}

export function evaluateConsistency(input: ConsistencyInput): ConsistencyReport {
  const violations: ConsistencyViolation[] = [];
  const verdict = input.verdict.verdict;

  // INV-4 前半：refused 表示拒判，不能拿证据类不变量去judge它；只做空报告。
  if (verdict === 'refused') {
    return { consistent: true, violations };
  }

  const zeroDiff = isZeroEffectiveDiff(input.latestDiff);
  const stalled = hasStallReason(input.stall);
  const rolledBack = isRollbackAction(input.rollback);

  // INV-1：improved 必须伴随有效 diff。
  if (verdict === 'improved' && zeroDiff) {
    violations.push({
      invariant: 'INV-1',
      severity: 'contradiction',
      detail: 'verdict=improved 但 latestDiff 为零有效变更（仅注释/空白或无 +/- 行）',
    });
  }

  // INV-2：not_improved + 回退 + 无停滞佐证 → 矛盾。
  // 振荡本身不强制矛盾（回退一代后再无改进可恰为 not_improved），故用 stall 合取收敛。
  if (verdict === 'not_improved' && rolledBack && !stalled) {
    violations.push({
      invariant: 'INV-2',
      severity: 'contradiction',
      detail: 'verdict=not_improved 且 rollback=rollback，但 stall 未给出停滞 reason（既非 undecidable/refused 也无停滞佐证）',
    });
  }

  // INV-3：improved + stall 停滞 → warning（不置 consistent=false）。
  if (verdict === 'improved' && stalled) {
    violations.push({
      invariant: 'INV-3',
      severity: 'warning',
      detail: 'verdict=improved 但 stall 判定停滞（单代改进幅度可能低于停滞阈值）',
    });
  }

  const consistent = !violations.some((v) => v.severity === 'contradiction');
  return { consistent, violations };
}

// ────────────────────────────────────────────────────────────────────────────
// B 项一致性阴影视图（codelens exp167 裁定，代理核对落地）
//
// 定位：纯旁路、只读、只审计。在 recordShadowAudit 里用真实多代行重建唯一可判定
// 判据 INV-3（improved ∧ 零证据停滞 → warning），其余两条按 codelens 裁定显式
// 列为 unavailableChecks——绝不拿空 diff 或人造 evidenceLevel 冒充已检查。
//
// ★审计安全护栏（codelens Q1 硬条件）：视图【不直出 consistent 布尔】、顶层键叫
//   consistencyShadow 而非 consistency——避免把「未检查」洗成「已通过」。
//   INV-1 无 diff 文本、INV-2 的 evidenceLevel 跨类型映射悬置（snapshot 的
//   partial/none 不在 EVIDENCE_LEVELS 值域里），两条恒不可用，固定列出。
//
// 不调用 evaluateConsistency 本体：它需要 5 个必填字段，而 latestDiff 传空串会被
// isZeroEffectiveDiff 判为零 diff → improved 假阳性 INV-1。这里只复刻其 INV-3
// 语义（stall.stopped），是单判据子集，不是完整一致性总判。
// ────────────────────────────────────────────────────────────────────────────

/** 多代行的最小投影（recordShadowAudit 从 policy_rsi_runs 只读查询得到）。 */
export interface ConsistencyShadowRow {
  readonly generation: number;
  readonly ledgerPath: string | null;
}

export interface ConsistencyShadowViolation {
  readonly inv: 'INV-3';
  readonly sev: 'warning';
  readonly gens: readonly number[];
  readonly msg: string;
}

export interface ConsistencyShadowUnavailable {
  readonly inv: 'INV-1' | 'INV-2';
  readonly cause: 'no_diff_text' | 'evidence_level_unmapped';
}

/** 紧凑审计视图；status 恒 partial，永不含 consistent 布尔。 */
export interface ConsistencyShadowView {
  readonly status: 'partial';
  readonly violations: readonly ConsistencyShadowViolation[];
  readonly unavailableChecks: readonly ConsistencyShadowUnavailable[];
}

const SHADOW_UNAVAILABLE: readonly ConsistencyShadowUnavailable[] = [
  { inv: 'INV-1', cause: 'no_diff_text' },
  { inv: 'INV-2', cause: 'evidence_level_unmapped' },
];

/**
 * 从多代真实行构造一致性阴影视图。
 *
 * @param rows 按任意顺序传入；内部按 generation 升序排序后交给 evaluateStall。
 * @param verdict 当前代影子判决六值字符串（shadow.verdict）。
 */
export function buildConsistencyShadow(
  rows: readonly ConsistencyShadowRow[],
  verdict: string,
): ConsistencyShadowView {
  const unavailableChecks = SHADOW_UNAVAILABLE;
  // INV-4 前半：refused 不做证据类判定，直接返回空 violations + 不可用清单。
  if (verdict === 'refused') {
    return { status: 'partial', violations: [], unavailableChecks };
  }

  const sorted = [...rows].sort((a, b) => a.generation - b.generation);
  // 零证据停滞唯一可重建：level 恒 landed（toEvidenceLevel 对六值一律 landed）、
  // artifactHash 用 ledger_path。failure/diff 无源，evaluateStall 的另两条判据恒不触发。
  const history: GenerationRecord[] = sorted.map((r) => ({
    evidence: {
      level: 'landed',
      ...(r.ledgerPath !== null ? { artifactHash: r.ledgerPath } : {}),
    },
  }));
  const stall = evaluateStall(history);

  const violations: ConsistencyShadowViolation[] = [];
  if (verdict === 'improved' && stall.stopped && stall.evidenceChain.length >= 2) {
    const gens = stall.evidenceChain
      .slice(0, 2)
      .map((idx) => sorted[idx]?.generation)
      .filter((g): g is number => typeof g === 'number');
    violations.push({
      inv: 'INV-3',
      sev: 'warning',
      gens,
      msg: 'improved+stall zero-evidence',
    });
  }
  return { status: 'partial', violations, unavailableChecks };
}
