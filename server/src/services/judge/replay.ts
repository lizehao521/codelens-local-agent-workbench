/**
 * Replay —— 判决复算（判据塔 v2）。
 *
 * 为什么需要它：v1 的 `context_json` 只存了 runtime + 两个金丝雀分数。
 * 一旦判据口径、阈值或证据变了，事后没人能回答「这条 fail 是怎么判出来的」。
 * 不可复算的判决等于不可审计的判决 —— 它只能被相信，不能被检验。
 *
 * 复算的硬约束：
 *  - **只读**。replay 不写任何一行；重复调用必须得到逐字节相同的 body。
 *  - **快照优先**。用 `context_json` 里的证据与阈值重算，不重读 π ——
 *    否则 π 一旦自我修改，历史判决就会集体「变心」。
 *  - **DB 现况只做漂移标记**。判决之后证据仍可能变（`tool_calls.status` 被改、
 *    `approvals` 后续写入、会话消息被压缩改写），这不是 bug：schema 刻意不给
 *    judge_runs 建外键，会话删了判决仍要能复盘。正因如此，现况不能参与
 *    reproduced 判定 —— 那会把「证据变了」误报成「判决错了」。
 */

import { sha256Hex } from '../../utils/hash.js';
import { L0_CRITERIA, type L0Thresholds } from './criteria.js';
import { summarize } from './summarize.js';
import { decodeSnapshot } from './snapshot-codec.js';
import type { SemanticAssessor, SemanticEvidence } from './semantic.js';
import { adversarialClaimEvidence } from './red-team.js';
import type { JudgeRunRow, JudgeVerdictRow } from '../../repositories/judge.repository.js';
import {
  type CriterionVerdict,
  type JudgeEvidence,
  type JudgeLayer,
  type JudgeSummary,
  type LayerProfile,
  type RunVerdict,
  type VerdictStatus,
} from './types.js';

/** 快照格式版本。旧行（无该字段）一律视为 1 = 未快照，不回填。 */
export const COVERAGE_VERSION = 2;

/** 判据集版本标识：口径变了必须改它，否则复算会把两种口径当成同一件事。 */
export const RULES_VERSION = 'criterion-set-v2';

/** 已知可复算的判据集版本。不在表里 → 无法确定口径 → unreproducible。 */
export const KNOWN_RULES_VERSIONS: ReadonlySet<string> = new Set([RULES_VERSION]);

export type ReplayEvidenceSource = 'snapshot' | 'current';

export type ReplayOutcome = 'reproduced' | 'unreproducible' | 'mismatch';

export interface JudgeReplayDiff {
  criterion: string;
  layer: JudgeLayer;
  recorded: string | number | null;
  recomputed: string | number | null;
  kind: 'status' | 'score' | 'missing' | 'extra';
}

export interface JudgeReplayResult {
  runId: number;
  outcome: ReplayOutcome;
  reproduced: boolean;
  recorded: {
    verdict: RunVerdict;
    coverage: number;
    towerCoverage: number;
    score: number;
    coverageVersion: number;
  };
  recomputed: { verdict: RunVerdict; coverage: number; towerCoverage: number; score: number } | null;
  diffs: JudgeReplayDiff[];
  evidence: {
    source: ReplayEvidenceSource;
    drifted: boolean;
    snapshotDigest: string | null;
    currentDigest: string;
  };
  judgeVersion: { rules: string; coverage: number; assessor: string | null } | null;
  reasons: string[];
}

export interface JudgeVersionSnapshot {
  rules: string;
  coverage: number;
  assessor: string | null;
}

/** 写进 `judge_runs.context_json` 的快照结构。 */
export interface JudgeRunContextSnapshot {
  coverageVersion: number;
  judgeVersion: JudgeVersionSnapshot;
  profiles: LayerProfile[];
  unavailableLayers: LayerProfile[];
  towerCoverage: number;
  towerExecuted: number;
  towerTotal: number;
  layerCoverage: Record<JudgeLayer, number | null>;
  /** resolveThresholds 之后的结果值：复算必须用当时的闸，不能用现在的 π。 */
  thresholds: L0Thresholds;
  context: {
    finishReason: string;
    iteration: number;
    tokenBudget: number;
    usage: { promptTokens: number; completionTokens: number };
    circuitOpened: boolean;
  };
  /** 必须存 status：只有分数无法区分「判据失效」和「判据判红」。 */
  canary: { status: VerdictStatus; goodScore: number; badScore: number };
  /**
   * 不可从快照证据重算的判据：工具纪律闸（读当前源码/测试目录）与
   * task.test_pass_rate（读当前沙箱）。判决时把结论一起快照，复算直接复用；
   * 重跑它们等于用今天的仓库状态改写历史判决，违背「快照优先」。
   */
  extraVerdicts?: CriterionVerdict[];
  evidence: JudgeEvidence | TruncatedEvidence;
  semantic: { assessorId: string; evidence: SemanticEvidence } | null;
  evidenceDigest: string;
  /** 定档理由与必需层缺口：复盘时必须能回答「为什么是 inconclusive」。 */
  reasons?: string[];
  requiredGaps?: Array<{ layer: JudgeLayer; reason: string }>;
  /** 本条判决是否被削弱（有可执行判据未执行）。 */
  degraded?: boolean;
  /** 顶层 runtime 平铺字段：v1 的读取方（及复算时的 finishReason 兜底）仍可能需要。 */
  finishReason?: string;
  iteration?: number;
  tokenBudget?: number;
  usage?: { promptTokens: number; completionTokens: number };
  circuitOpened?: boolean;
}

/** 证据超限时只留摘要：完整落库会把 judge_runs 撑成第二个 tool_calls 表。 */
export interface TruncatedEvidence {
  digest: string;
  truncated: true;
  counts: { toolCalls: number; approvals: number };
}

export function isTruncatedEvidence(e: JudgeEvidence | TruncatedEvidence): e is TruncatedEvidence {
  return (e as TruncatedEvidence).truncated === true;
}

/** 剥掉 runtime 字段后即可作为快照解析结果；解析失败一律返回 null（=不可复算）。 */
export function parseContextSnapshot(json: string | null): JudgeRunContextSnapshot | null {
  const parsed = decodeSnapshot(json);
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed as JudgeRunContextSnapshot;
}

// ── canonical JSON + digest ────────────────────────────────────────────────

/** 数值统一保留三位小数：浮点噪声不该让 digest 抖动。 */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * 键排序 + 数组保序 + 数值 round3 的规范化 JSON。
 * 不复用 utils/digest.ts：那套会剔除 volatile 字段，语义是为审批参数服务的，
 * 用在这里会悄悄丢掉证据里的字段。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(round3(value)) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source)
    .filter((k) => source[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(source[k])}`).join(',')}}`;
}

/** digest 的语义输入：只包含「判据真正读过的东西」。 */
export interface EvidenceDigestInput {
  toolCalls: Array<{ status: string; display_name: string; error_kind?: string | null; exit_code?: number | null }>;
  approvals: Array<{ status: string; decision: string | null }>;
  semantic: {
    goalHash: string;
    finalAnswerHash: string;
    assistantTurns: number;
    toolSummary: { total: number; success: number; failed: number };
    finishReason: string;
  } | null;
}

export function evidenceDigestOf(input: EvidenceDigestInput): string {
  return sha256Hex(canonicalJson(input));
}

/** 从语义证据构造 digest 片段。文本只留哈希：原文不动，但可比对是否漂移。 */
export function semanticDigestPart(e: SemanticEvidence): EvidenceDigestInput['semantic'] {
  return {
    goalHash: sha256Hex(e.goal),
    finalAnswerHash: sha256Hex(e.finalAnswer),
    assistantTurns: e.assistantTurns,
    toolSummary: e.toolSummary,
    finishReason: e.finishReason,
  };
}

// ── 复算 ──────────────────────────────────────────────────────────────────

export interface ReplayInputs {
  runId: number;
  row: JudgeRunRow;
  snapshot: JudgeRunContextSnapshot | null;
  recordedVerdicts: JudgeVerdictRow[];
  /** DB 现况算出的 digest：只用于漂移标记。 */
  currentDigest: string;
  source: ReplayEvidenceSource;
  /** 当前进程注册的语义评估器；与快照不一致时该层无法复算。 */
  assessor?: SemanticAssessor;
}

const TOLERANCE = 1e-3;

/**
 * 纯函数式复算：输入全部显式传入，不碰 DB、不读 π、不取时间。
 * 因此「同一行 replay 两次必须一样」是结构上成立的，而不是靠运气。
 */
export function replayRun(input: ReplayInputs): JudgeReplayResult {
  const { row, snapshot, recordedVerdicts, currentDigest, source, assessor } = input;
  const snapshotDigest = snapshot?.evidenceDigest ?? null;
  const drifted = snapshotDigest !== null && snapshotDigest !== currentDigest;

  const recorded = {
    verdict: row.verdict,
    coverage: row.coverage,
    towerCoverage: snapshot?.towerCoverage ?? row.coverage,
    score: row.score,
    coverageVersion: snapshot?.coverageVersion ?? 1,
  };

  const base = {
    runId: input.runId,
    recorded,
    diffs: [] as JudgeReplayDiff[],
    evidence: { source, drifted, snapshotDigest, currentDigest },
    judgeVersion: snapshot?.judgeVersion ?? null,
  };

  // ① 旧行 / 无快照：不回填，直接承认不可复算。
  if (!snapshot || snapshot.coverageVersion !== COVERAGE_VERSION) {
    return {
      ...base,
      outcome: 'unreproducible',
      reproduced: false,
      recomputed: null,
      reasons: ['evidence_not_snapshotted'],
    };
  }

  // ② 口径未知：复算出来的东西和当时的判据可能不是一回事。
  if (!snapshot.judgeVersion || !KNOWN_RULES_VERSIONS.has(snapshot.judgeVersion.rules)) {
    return {
      ...base,
      outcome: 'unreproducible',
      reproduced: false,
      recomputed: null,
      reasons: ['judge_version_unknown'],
    };
  }

  // ③ 证据被截断：重算用的是残缺证据，结论没有证明力。
  if (isTruncatedEvidence(snapshot.evidence)) {
    return {
      ...base,
      outcome: 'unreproducible',
      reproduced: false,
      recomputed: null,
      reasons: ['evidence_truncated'],
    };
  }

  // ④ 语义评估器换了实现：L2 那一条无法用「当时的判据」重算。
  if (snapshot.semantic && (!assessor || assessor.id !== snapshot.semantic.assessorId)) {
    return {
      ...base,
      outcome: 'unreproducible',
      reproduced: false,
      recomputed: null,
      reasons: ['assessor_not_reproducible'],
    };
  }

  const recomputedVerdicts = recomputeVerdicts(snapshot, assessor);
  const summary: JudgeSummary = summarize(recomputedVerdicts, snapshot.profiles);

  const byCriterion = new Map<string, CriterionVerdict>();
  for (const v of recomputedVerdicts) byCriterion.set(`${v.layer}:${v.criterion}`, v);

  const diffs: JudgeReplayDiff[] = [];
  const reasons: string[] = [];
  let missing = false;

  for (const rec of recordedVerdicts) {
    const key = `${rec.layer}:${rec.criterion}`;
    const now = byCriterion.get(key);
    if (!now) {
      missing = true;
      diffs.push({
        criterion: rec.criterion,
        layer: rec.layer,
        recorded: rec.status,
        recomputed: null,
        kind: 'missing',
      });
      continue;
    }
    byCriterion.delete(key);
    if (now.status !== rec.status) {
      diffs.push({
        criterion: rec.criterion,
        layer: rec.layer,
        recorded: rec.status,
        recomputed: now.status,
        kind: 'status',
      });
    }
    const before = rec.score;
    const after = now.score ?? null;
    if (typeof before === 'number' && typeof after === 'number' && Math.abs(before - after) > TOLERANCE) {
      diffs.push({
        criterion: rec.criterion,
        layer: rec.layer,
        recorded: before,
        recomputed: after,
        kind: 'score',
      });
    }
  }
  // 记录里没有、重算里有：只可能在判据集扩容后出现，属于口径变化而非漂移。
  for (const extra of byCriterion.values()) {
    diffs.push({ criterion: extra.criterion, layer: extra.layer, recorded: null, recomputed: extra.status, kind: 'extra' });
  }

  // ⑤ 快照缺了这条 run 记录过的判据：快照不自足，不能声称复算成功。
  if (missing) {
    return { ...base, outcome: 'unreproducible', reproduced: false, recomputed: toRecomputed(summary), diffs, reasons: ['snapshot_missing_criterion'] };
  }

  if (row.verdict !== summary.verdict) reasons.push('verdict_mismatch');
  if (Math.abs(row.coverage - summary.coverage) > TOLERANCE) reasons.push('coverage_mismatch');
  if (Math.abs(row.score - summary.score) > TOLERANCE) reasons.push('score_mismatch');

  const outcome: ReplayOutcome = reasons.length === 0 ? 'reproduced' : 'mismatch';
  // 证据漂移 + 判决不符：此时「判决错了」和「证据被改过」都成立，必须标明冲突。
  if (outcome === 'mismatch' && drifted) reasons.push('evidence_conflict');

  return {
    ...base,
    outcome,
    reproduced: outcome === 'reproduced',
    recomputed: toRecomputed(summary),
    diffs,
    reasons,
  };
}

function toRecomputed(s: JudgeSummary) {
  return {
    verdict: s.verdict,
    coverage: s.coverage,
    towerCoverage: s.towerCoverage,
    score: s.score,
  };
}

/**
 * 用快照里的证据 + 当时的阈值重跑整座塔。
 *
 * L1 直接取快照里的 canary.status：金丝雀的输入是合成样本而非本轮证据，
 * 它的结论属于「当时的判据能力」，重跑它等于用今天的判据替换当时的判据。
 * 同理 L0 是否降级取决于当时金丝雀是否通过 —— 这一步必须复刻，否则
 * 「判据失效那轮的判决」会被复算成完全不同的形状。
 */
function recomputeVerdicts(snapshot: JudgeRunContextSnapshot, assessor?: SemanticAssessor): CriterionVerdict[] {
  const evidence = snapshot.evidence as JudgeEvidence;
  const thresholds = snapshot.thresholds;
  const l0Trusted = snapshot.canary.status === 'pass';

  const l0: CriterionVerdict[] = L0_CRITERIA.map((fn) => fn(evidence, thresholds)).map((v) =>
    l0Trusted ? v : { ...v, status: 'unexec' as const, detail: '快照显示当时金丝雀未通过，L0 结论作废' },
  );

  const l1: CriterionVerdict = {
    layer: 'L1',
    criterion: 'canary.discrimination',
    status: snapshot.canary.status,
    detail: `复算取自快照：金丝雀当时为 ${snapshot.canary.status}`,
  };

  const l2: CriterionVerdict = snapshot.semantic && assessor
    ? assessor.assess(snapshot.semantic.evidence)
    : {
        layer: 'L2',
        criterion: 'semantic.task_completion',
        status: 'unexec',
        detail: '快照中无语义证据，L2 按未执行复算',
      };

  // L3 复算必须与判决时同源：用快照里的回答文本重新核对声明与证据。
  // 写成常量会让「原判决有 L3 结论、复算却是 unexec」永远对不上。
  const l3: CriterionVerdict = adversarialClaimEvidence(
    evidence,
    snapshot.semantic ? snapshot.semantic.evidence : null,
  );

  // 不可重算的判据（工具纪律闸 / 代码修复族读数）一律取快照里的结论。
  // 它们依赖「当前仓库」而非本轮证据，现场重跑会让历史判决跟着代码漂移。
  const extra = snapshot.extraVerdicts ?? [];

  return [...l0, l1, ...extra, l2, l3];
}
