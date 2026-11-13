// RSI 规则契约镜像与自我迭代端点（自 api.ts 拆出；公开导出面不变）
import type { JudgeRunVerdict, JudgeVerdictStatus } from './api-judge';
import { ApiError, parseErrorResponse } from './api-http';

// 只做类型镜像，不做任何取值加工：overview.rules 与独立的 rules 端点都是后端
// 直接下发的契约 JSON，字段名本身已是 camelCase。契约的完整兜底值在
// client/src/lib/rsi-rules.ts，旧后端不下发 rules 时由它接管渲染。

/** 语义 tone —— 四值枚举，tone → Tailwind 语义类的映射在 rsi-rules.ts。 */
export type RsiTone = 'success' | 'danger' | 'warning' | 'muted';

/** RSI 代际判决 6 态 —— 真相源 server/src/services/rsi/rsi-bridge.service.ts:33。 */
export type RsiVerdictState =
  | 'improved' | 'not_improved' | 'refused' | 'undecidable' | 'skipped' | 'error';

export interface RsiRuleDefinition {
  id: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';
  name: string;
  kind: 'rejection' | 'comparison';
  appliesWhen: string;
  criterion: string;
  onHit: string;
  resultsIn: RsiVerdictState[];
  exitCodes: Array<number | null>;
  order: number;
  anchor: string;
}

export interface RsiStateDefinition {
  state: RsiVerdictState;
  exitCode: number | null;
  label: string;
  tone: RsiTone;
  meaning: string;
  action: string;
  origin: 'krsi' | 'bridge';
}

export interface RsiLabeledState<S extends string> {
  state: S;
  label: string;
  tone: RsiTone;
}

export interface RsiBasisDefinition {
  value: 1 | 2 | 3 | 4 | 5;
  name: string;
  label: string;
  requiredField: string | null;
  note: string;
}

export interface RsiRulesContract {
  version: 'rsi-rules-contract-v1';
  authority: string;
  rules: RsiRuleDefinition[];
  states: RsiStateDefinition[];
  judgeRunStates: Array<RsiLabeledState<'pass' | 'fail' | 'inconclusive'>>;
  criterionStatuses: Array<RsiLabeledState<'pass' | 'fail' | 'unexec'>>;
  basis: RsiBasisDefinition[];
  roles: Array<{ role: 'objective' | 'guard'; label: string; requirement: string }>;
  thresholds: {
    minToolSuccessRate: number;
    maxApprovalRejectionRate: number;
    maxBudgetUsageRate: number;
    coverageThreshold: number;
  };
  reasonRuleIdPattern: '^(R[1-6]):';
  outOfScope: string[];
  /**
   * 自我迭代能力的三组定义（后端为可选字段，旧后端不下发时前端降级）。
   * 不升契约版本：新增可选字段不是破坏性变更，两端可以不同步发布。
   */
  domains?: RsiDomainDefinition[];
  decisions?: RsiDecisionDefinition[];
  iterationCriteria?: RsiCriterionDefinition[];
}

/** 变更域：能改到哪、要谁批、上限多少。 */
export interface RsiDomainDefinition {
  id: 'D0' | 'D1' | 'D2' | 'D3' | 'D4';
  label: string;
  requiresHumanApproval: boolean;
  maxFiles: number;
  autoAllowedBy: string[];
  rationale: string;
}

/** 迭代决策：这一轮的去留。 */
export interface RsiDecisionDefinition {
  decision: 'continue' | 'retry' | 'rollback' | 'escalate' | 'halt';
  label: string;
  tone: RsiTone;
  action: string;
}

/** 迭代判据：量化阈值。 */
export interface RsiCriterionDefinition {
  id: string;
  name: string;
  threshold: string;
  onFail: 'continue' | 'retry' | 'rollback' | 'escalate' | 'halt' | null;
}

/** 单条迭代记录（GET /api/v1/rsi/iterations）。 */
export interface RsiIterationRecord {
  id: string;
  task: string;
  at: string;
  attempt: number;
  verdict: RsiVerdictState;
  domain: string;
  trigger: string;
  version: string | null;
  raw: Record<string, unknown>;
  result: {
    decision: 'continue' | 'retry' | 'rollback' | 'escalate' | 'halt';
    headline: string;
    criteria: Array<{ id: string; name: string; threshold: string; actual: string; status: 'pass' | 'fail' | 'unexec'; onFail: string | null }>;
    rollbackReasons: string[];
    confidence: number;
  };
}

export interface RsiIterationList {
  items: RsiIterationRecord[];
  summary: { total: number; byDecision: Record<string, number>; byDomain: Record<string, number>; attention: number };
  domains: Array<{ id: string; label: string; requiresHumanApproval: boolean }>;
  /** 此刻循环正在用的模型（按归因轮换）与服务端时间，供状态条显示新鲜度。 */
  model?: string;
  serverTime?: string;
}

/** 域申请的结果（POST /api/v1/rsi/iterations/plan）。 */
export interface RsiDomainPlan {
  ok: boolean;
  domain: string;
  domainLabel: string;
  reasons: string[];
  required?: 'human-approval';
  limits: { maxFiles: number; fileCount: number };
}

/** 判据塔的一次判决（judge_runs 行）。 */
export interface RsiJudgeRun {
  id: number;
  verdict: JudgeRunVerdict;
  /** 整体加权得分 0..1 */
  score: number;
  /** 必需层覆盖率 0..1 */
  coverage: number;
  executed: number;
  total: number;
  createdAt: number;
}

/** 套件级结构化结果（eval.suites[] / verdict.data.suites[]）。 */
export interface RsiEvalSuite {
  id: string;
  title: string;
  ok: boolean;
  passed: number;
  total: number;
  publicPassed: number;
  publicTotal: number;
  /** 套件级错误（仅失败时可能有） */
  error: string | null;
}

/**
 * task.test_pass_rate 的结构化读数。
 * 旧会话（source=detail_only）数值全为 null、suites 为空，不能把 null 当 0。
 */
export interface RsiEvalData {
  passed: number | null;
  total: number | null;
  denominator: number | null;
  score: number | null;
  suites: RsiEvalSuite[];
  /** 评测集指纹（16 位十六进制）；旧会话为 null，变化即基线断裂 */
  evalSetFingerprint?: string | null;
  /** 套件级机械失败分类：public_fail / hidden_only / suite_error / passed */
  failureKinds?: Record<string, number>;
  /** 探针采样次数；1 表示 pass^k 不可计算 */
  samples?: number;
  /** 'unmeasured' | 'measured' */
  reliability?: string;
}

/** 接口顶层的 eval 读数：结构化数据或旧格式的 detail 回退说明。 */
export interface RsiEval extends RsiEvalData {
  runId: number;
  status: JudgeVerdictStatus;
  detail: string | null;
  measuredAt: number;
  /** structured = 有结构化套件/分母；detail_only = 旧会话，只有文本 */
  source: string;
}

/** 单条判据结果（judge_verdicts 行）。 */
export interface RsiVerdictRow {
  runId: number;
  layer: string;
  criterion: string;
  status: JudgeVerdictStatus;
  score: number | null;
  detail: string | null;
  /** 判据的结构化数据；旧会话为 null */
  data: RsiEvalData | null;
}

/** 一次 RSI 代际对比（policy_rsi_runs 行）。 */
export interface RsiRunRow {
  generation: number;
  prevGeneration: number | null;
  /** 6 态判决（rsi-bridge.service.ts:33）。契约外的值由分派层降级显示，不伪造成已测结论。 */
  verdict: RsiVerdictState;
  exitCode: number | null;
  reasons: string[];
}

/** 一条 RSI 归因经验（policy_injections 行）。 */
export interface RsiAttributionRow {
  id: number;
  policyVersion: number | null;
  lesson: string;
  createdAt: number;
}

export interface RsiOverview {
  session: {
    id: string;
    title: string;
    provider: string;
    model: string;
    createdAt: number;
  };
  /** 按创建时间升序的判据塔判决 */
  judgeRuns: RsiJudgeRun[];
  /** runId -> 该次判决的全部判据 */
  verdictsByRun: Record<number, RsiVerdictRow[]>;
  /** 最近一次 task.test_pass_rate 读数（结构化或 detail_only）；老库可能没有 */
  eval: RsiEval | null;
  rsiRuns: RsiRunRow[];
  attributions: RsiAttributionRow[];
  /**
   * 规则契约（Spec §3 增量）。旧后端不下发该字段 → null，
   * 面板统一走 client/src/lib/rsi-rules.ts 的兜底契约，不白屏（AC-08）。
   */
  rules?: RsiRulesContract | null;
}

/** 把 suites[] 的 snake_case / 缺省值归一化。 */
function mapEvalSuites(raw: unknown): RsiEvalSuite[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    return {
      id: String(row.id ?? ''),
      title: String(row.title ?? row.id ?? ''),
      ok: row.ok === true,
      passed: Number(row.passed ?? 0),
      total: Number(row.total ?? 0),
      publicPassed: Number(row.public_passed ?? row.publicPassed ?? 0),
      publicTotal: Number(row.public_total ?? row.publicTotal ?? 0),
      error: typeof row.error === 'string' ? row.error : null,
    };
  });
}

/** 结构化读数：数值保持 null 语义（旧格式不能当 0）。 */
function mapEvalData(raw: unknown): RsiEvalData | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  // 评测运行元数据（server/src/app.ts:255-262 已下发）。旧行没有这些字段时给中性缺省：
  // 指纹 null / 失败分类空对象 / 采样 1 / 可靠性 unmeasured —— 与后端同一口径，
  // 缺失就是缺失，绝不把「未标注 / 未测」伪装成已测值（AC-07）。
  const fingerprint = row.evalSetFingerprint ?? row.eval_set_fingerprint;
  const failureKinds = row.failureKinds;
  return {
    passed: typeof row.passed === 'number' ? row.passed : null,
    total: typeof row.total === 'number' ? row.total : null,
    denominator: typeof row.denominator === 'number' ? row.denominator : null,
    score: typeof row.score === 'number' ? row.score : null,
    suites: mapEvalSuites(row.suites),
    evalSetFingerprint: typeof fingerprint === 'string' ? fingerprint : null,
    failureKinds:
      failureKinds && typeof failureKinds === 'object' && !Array.isArray(failureKinds)
        ? (failureKinds as Record<string, number>)
        : {},
    samples: typeof row.samples === 'number' ? row.samples : 1,
    reliability: typeof row.reliability === 'string' ? row.reliability : 'unmeasured',
  };
}

function mapEval(raw: unknown): RsiEval | null {
  const base = mapEvalData(raw);
  if (!base) return null;
  const row = raw as Record<string, unknown>;
  return {
    ...base,
    runId: Number(row.runId ?? row.run_id ?? 0),
    status: String(row.status ?? 'unexec') as JudgeVerdictStatus,
    detail: typeof row.detail === 'string' ? row.detail : null,
    measuredAt: Number(row.measuredAt ?? row.measured_at ?? 0),
    source: String(row.source ?? ''),
  };
}

function parseReasons(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 契约只做最低限度的形状校验：它是后端同源下发的完整 JSON，前端不做逐字段加工。
 * 旧后端（无 rules）或半截脏数据一律视为「没有契约」，交给 rsi-rules.ts 的
 * 兜底契约接管，保证面板不白屏（AC-08）。
 * 版本只要求是字符串、不锁死 v1：契约升版后形状合法的新契约仍须被采用，
 * 否则会被误判成「无契约」而静默退回旧兜底（沉默逻辑错误）。
 */
function isRulesContractLike(raw: unknown): raw is RsiRulesContract {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Record<string, unknown>;
  return (
    typeof value.version === 'string' && value.version.length > 0 &&
    Array.isArray(value.rules) &&
    Array.isArray(value.states) &&
    Array.isArray(value.judgeRunStates) &&
    Array.isArray(value.criterionStatuses) &&
    typeof value.reasonRuleIdPattern === 'string'
  );
}

/**
 * 读取当前会话的 RSI 读数。
 *
 * 网络层失败（后端没启动 / 端口不通）单独抛 `BACKEND_UNREACHABLE`，
 * 方便界面区分「服务不可达」与「接口报错」，而不是统一显示 Failed to fetch。
 */
export async function getRsiOverview(sessionId: string): Promise<RsiOverview> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/rsi/overview?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
  } catch {
    throw new ApiError(
      'BACKEND_UNREACHABLE',
      '无法连接后端服务（可能未启动或端口不通），启动后点「重试」即可。',
      0,
    );
  }
  if (!res.ok) {
    if (res.status === 404) {
      throw new ApiError('SESSION_NOT_FOUND', '会话不存在或已被删除，无法读取 RSI 读数。', 404);
    }
    throw await parseErrorResponse(res);
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new ApiError('BAD_RESPONSE', 'RSI 接口返回格式异常（不是合法 JSON）。', res.status);
  }
  const data = raw as {
    session?: Record<string, unknown>;
    judgeRuns?: Array<Record<string, unknown>>;
    verdictsByRun?: Record<string, Array<Record<string, unknown>>>;
    eval?: unknown;
    rsiRuns?: Array<Record<string, unknown>>;
    attributions?: Array<Record<string, unknown>>;
    rules?: unknown;
  } | null;
  if (!data || typeof data !== 'object' || !data.session || !Array.isArray(data.judgeRuns)) {
    throw new ApiError('BAD_RESPONSE', 'RSI 接口返回格式异常：缺少 session / judgeRuns。', res.status);
  }

  const verdictsByRun: Record<number, RsiVerdictRow[]> = {};
  for (const [key, rows] of Object.entries(data.verdictsByRun ?? {})) {
    const runId = Number(key);
    if (!Number.isFinite(runId) || !Array.isArray(rows)) continue;
    verdictsByRun[runId] = rows.map((row) => ({
      runId: Number(row.run_id ?? runId),
      layer: String(row.layer ?? ''),
      criterion: String(row.criterion ?? ''),
      status: row.status as JudgeVerdictStatus,
      score: typeof row.score === 'number' ? row.score : null,
      detail: typeof row.detail === 'string' ? row.detail : null,
      data: mapEvalData(row.data),
    }));
  }

  return {
    session: {
      id: String(data.session.id ?? ''),
      title: String(data.session.title ?? '未命名会话'),
      provider: String(data.session.provider ?? ''),
      model: String(data.session.model ?? ''),
      createdAt: Number(data.session.created_at ?? 0),
    },
    judgeRuns: data.judgeRuns.map((run) => ({
      id: Number(run.id),
      verdict: run.verdict as JudgeRunVerdict,
      score: typeof run.score === 'number' ? run.score : 0,
      coverage: typeof run.coverage === 'number' ? run.coverage : 0,
      executed: Number(run.executed ?? 0),
      total: Number(run.total ?? 0),
      createdAt: Number(run.created_at ?? 0),
    })),
    verdictsByRun,
    eval: mapEval(data.eval),
    rsiRuns: (data.rsiRuns ?? []).map((run) => ({
      generation: Number(run.generation ?? 0),
      prevGeneration: typeof run.prev_generation === 'number' ? run.prev_generation : null,
      verdict: String(run.verdict ?? '') as RsiVerdictState,
      exitCode: typeof run.exit_code === 'number' ? run.exit_code : null,
      reasons: parseReasons(run.reasons_json),
    })),
    attributions: (data.attributions ?? []).map((row) => ({
      id: Number(row.id ?? 0),
      policyVersion: typeof row.policy_version === 'number' ? row.policy_version : null,
      lesson: String(row.lesson ?? ''),
      createdAt: Number(row.created_at ?? 0),
    })),
    rules: isRulesContractLike(data.rules) ? data.rules : null,
  };
}

/**
 * GET /api/v1/rsi/rules —— 独立规则契约（Spec §3 新增，无需 session）。
 * 与 overview.rules 同源（后端同调 buildRsiRulesContract），供独立看板与
 * 一致性校验脚本消费。失败时抛 ApiError，由调用方降级到兜底契约。
 */
export async function getRsiRules(): Promise<RsiRulesContract> {
  let res: Response;
  try {
    res = await fetch('/api/v1/rsi/rules', { cache: 'no-store' });
  } catch {
    throw new ApiError('BACKEND_UNREACHABLE', '无法连接后端服务（可能未启动或端口不通）。', 0);
  }
  if (!res.ok) throw await parseErrorResponse(res);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new ApiError('BAD_RESPONSE', '规则契约接口返回格式异常（不是合法 JSON）。', res.status);
  }
  if (!isRulesContractLike(raw)) {
    throw new ApiError('BAD_RESPONSE', '规则契约接口返回格式异常：缺少 rules[] / states[]。', res.status);
  }
  return raw;
}

// ── 自我迭代（RSI）──────────────────────────────────────────────────────
// 统一走 /api/v1/rsi/*：读端点三个、动作端点两个。动作端点后端只记录不改代码，
// 回滚由脚本按快照执行——所以这里没有「一键还原仓库」这种危险方法。

/** 迭代列表 + 汇总 + 域表。 */
export async function getRsiIterations(limit = 50): Promise<RsiIterationList> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/rsi/iterations?limit=${limit}`, { cache: 'no-store' });
  } catch {
    throw new ApiError('BACKEND_UNREACHABLE', '无法连接后端服务（可能未启动或端口不通）。', 0);
  }
  if (!res.ok) throw new ApiError('RSI_ITERATIONS_FAILED', `读取迭代列表失败（HTTP ${res.status}）`, res.status);
  return (await res.json()) as RsiIterationList;
}

/** 域申请：给定拟改文件与触发方式，问「能不能改、要谁批」。纯计算，无副作用。 */
export async function planRsiDomain(input: {
  files: string[];
  trigger?: string;
  humanApproved?: boolean;
}): Promise<RsiDomainPlan> {
  let res: Response;
  try {
    res = await fetch('/api/v1/rsi/iterations/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'manual', humanApproved: false, ...input }),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('BACKEND_UNREACHABLE', '无法连接后端服务（可能未启动或端口不通）。', 0);
  }
  if (!res.ok) throw new ApiError('RSI_PLAN_FAILED', `域申请失败（HTTP ${res.status}）`, res.status);
  return (await res.json()) as RsiDomainPlan;
}

/** 记录人对某条迭代的决定。后端只追加一行决策日志，不改动任何代码。 */
export async function decideRsiIteration(
  id: string,
  action: 'approve' | 'rollback' | 'halt',
  note?: string,
): Promise<{ ok: boolean; note: string }> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/rsi/iterations/${encodeURIComponent(id)}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // confirm 只对破坏性动作有意义，但统一带上：后端对 approve 不校验它。
      body: JSON.stringify({ action, confirm: action !== 'approve', note }),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('BACKEND_UNREACHABLE', '无法连接后端服务（可能未启动或端口不通）。', 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new ApiError('RSI_DECIDE_FAILED', body.error?.message ?? `记录决定失败（HTTP ${res.status}）`, res.status);
  }
  return (await res.json()) as { ok: boolean; note: string };
}
