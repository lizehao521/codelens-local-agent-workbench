// 判据塔（Judge）只读视图与类型（自 api.ts 拆出；公开导出面不变）
import { get, send, withQuery } from './api-http';

// 服务端不接受判决写入：r 只能来自运行期 Judge，不能由 HTTP 请求伪造。

export type JudgeVerdictStatus = 'pass' | 'fail' | 'unexec';
export type JudgeRunVerdict = 'pass' | 'fail' | 'inconclusive';
export type JudgeLayerId = 'L0' | 'L1' | 'L2' | 'L3';

/** 一次判决的汇总。coverage < 1 表示有判据未执行（不是失败，但也不等于通过）。 */
export interface JudgeRunSummary {
  id: number;
  sessionId: string;
  verdict: JudgeRunVerdict;
  score: number;
  /** 主口径覆盖率：分母只含本进程真正有能力判定的层。判决据此定档。 */
  coverage: number;
  executed: number;
  total: number;
  /** 1 = v1 未快照的旧行；2 = v2（有证据/阈值快照，可复算）。 */
  coverageVersion: number;
  /** 全塔口径覆盖率：仅展示，不参与定档。 */
  towerCoverage: number;
  /** 有层不可用时为 true：此时「通过」只代表可用判据全绿。 */
  degraded: boolean;
  unavailableLayers?: JudgeLayerProfile[];
  reasons?: string[];
  createdAt: number;
  /** rules = 规则判决；deep = LLM 深判派生出的追加行（不改写原判决）。 */
  tier?: 'rules' | 'deep';
  parentRun?: number | null;
  /** 原判决上的「已深判」指引；未深判为 null。 */
  latestDeep?: {
    id: number;
    verdict: JudgeRunVerdict;
    score: number;
    coverage: number;
    model: string | null;
    failure: string | null;
    createdAt: number;
  } | null;
}

export interface JudgeLayerProfile {
  layer: JudgeLayerId;
  available: boolean;
  required: boolean;
  reason: string | null;
  detail?: string;
}

export type JudgeReplayOutcome = 'reproduced' | 'mismatch' | 'unreproducible';

export interface JudgeReplayDiff {
  criterion: string;
  layer: JudgeLayerId;
  recorded: string | number | null;
  recomputed: string | number | null;
  kind: 'status' | 'score' | 'missing' | 'extra';
}

/** 判决复算结果：reproduced=结论可复现，mismatch=重算不符，unreproducible=证据不足。 */
export interface JudgeReplayResult {
  runId: number;
  outcome: JudgeReplayOutcome;
  reproduced: boolean;
  recorded: { verdict: JudgeRunVerdict; coverage: number; towerCoverage: number; score: number; coverageVersion: number };
  recomputed: { verdict: JudgeRunVerdict; coverage: number; towerCoverage: number; score: number } | null;
  diffs: JudgeReplayDiff[];
  evidence: { source: 'snapshot' | 'current'; drifted: boolean; snapshotDigest: string | null; currentDigest: string };
  judgeVersion: { rules: string; coverage: number; assessor: string | null } | null;
  reasons: string[];
}

export interface JudgeCriterionVerdict {
  id: number;
  layer: JudgeLayerId;
  criterion: string;
  status: JudgeVerdictStatus;
  score: number | null;
  detail: string | null;
}

export interface JudgeCanaryCase {
  name: string;
  expected: 'good' | 'bad';
  score: number | null;
  unexec: string[];
}

/** 判据塔自证状态：回答「它现在还有没有资格判决」。 */
export interface JudgeSelfCheck {
  canary: {
    status: JudgeVerdictStatus;
    detail: string;
    goodScore: number;
    badScore: number;
    cases: JudgeCanaryCase[];
    semantic?: {
      assessorId: string;
      ok: boolean;
      detail: string;
      cases: Array<{ name: string; expected: 'pass' | 'fail'; actual: JudgeVerdictStatus; ok: boolean }>;
    } | null;
  };
  thresholds: {
    minToolSuccessRate: number;
    maxApprovalRejectionRate: number;
    maxBudgetUsageRate: number;
  };
  /** 覆盖率门槛由服务端下发：前端不要另存一份 0.6。 */
  coverageThreshold?: number;
  unimplementedLayers: Array<{ layer: JudgeLayerId; reason: string }>;
  profiles?: JudgeLayerProfile[];
  degraded?: boolean;
  criteria: Array<{
    criterion: string;
    layer: JudgeLayerId;
    pass: number;
    fail: number;
    unexec: number;
    total: number;
  }>;
  totalRuns: number;
}

/** π 经验的事后有效性：注入过该经验的会话，最终判决分布如何。 */
export interface LessonEffectivenessRow {
  lesson: string;
  injected: number;
  passes: number;
  fails: number;
  inconclusive: number;
  pending: number;
  passRate: number | null;
}

/** GET /api/v1/judge/runs —— 判决历史（可按会话过滤）。 */
export async function getJudgeRuns(params: { sessionId?: string; limit?: number } = {}): Promise<JudgeRunSummary[]> {
  const res = await get<{ runs: JudgeRunSummary[] }>(
    withQuery('/judge/runs', { sessionId: params.sessionId, limit: params.limit }),
  );
  return res.runs;
}

/** GET /api/v1/judge/runs/:id —— 单次判决的逐条判据。 */
export async function getJudgeRun(
  id: number,
): Promise<{ run: JudgeRunSummary & { context: unknown; towerTotal?: number | null }; verdicts: JudgeCriterionVerdict[] }> {
  return get(`/judge/runs/${id}`);
}

/**
 * GET /api/v1/judge/runs/:id/replay —— 判决复算（只读、幂等）。
 *
 * 用判决当时的证据与阈值重算，返回 reproduced / mismatch / unreproducible。
 * unreproducible 也是 200：它是一条结论（证据没存够），不是请求失败。
 */
export async function replayJudgeRun(
  id: number,
  evidence: 'snapshot' | 'current' = 'snapshot',
): Promise<JudgeReplayResult> {
  return get(`/judge/runs/${id}/replay?evidence=${evidence}`);
}

/** 深判返回的判据条目：与 getRun 的条目不同，它没有数据库 id（还没被读回来）。 */
export interface JudgeDeepVerdict {
  layer: JudgeLayerId;
  criterion: string;
  status: JudgeVerdictStatus;
  score?: number;
  detail?: string;
}

/**
 * 深判结果。
 *
 * 三种终局都是正常响应：`ok`（判出来了）、`unexec`（不可判/上游失败）、
 * `reused`（同一组参数此前已判过，直接复用）。只有被并发闸挡下才是 HTTP 409/429。
 */
export interface JudgeDeepResult {
  status: 'ok' | 'unexec' | 'reused';
  parentRun: number;
  runId: number | null;
  reused: boolean;
  wroteRow: boolean;
  tier: 'deep';
  failure: string | null;
  reason: string | null;
  deep: {
    assessorId: string;
    promptTemplateVersion: number;
    provider: {
      providerId: string;
      model: string;
      baseUrlHost: string;
      keySource: 'client' | 'server';
      modelSource: 'env' | 'request' | 'session';
    };
    temperature: number;
    usage: { promptTokens: number; completionTokens: number };
    latencyMs: number;
    failure: string | null;
    reason: string | null;
    injectionSuspected: boolean;
  } | null;
  verdict: JudgeRunVerdict | null;
  score: number | null;
  coverage: number | null;
  reasons: string[];
  verdicts: JudgeDeepVerdict[];
}

export interface JudgeDeepRequest {
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** 仅本次调用使用；服务端承诺不落库、不写日志。 */
  credentials?: { apiKey?: string; baseUrl?: string };
  force?: boolean;
  timeoutMs?: number;
}

/** 事后深判：用 LLM 重判某次运行的 L2 语义层，追加一条子判决。 */
export async function deepJudgeRun(id: number, body: JudgeDeepRequest = {}): Promise<JudgeDeepResult> {
  return send<JudgeDeepResult>(`/judge/runs/${id}/deep-judge`, body);
}

/** GET /api/v1/judge/selfcheck —— 金丝雀判别力 + 阈值 + 未实现层声明。 */
export async function getJudgeSelfCheck(): Promise<JudgeSelfCheck> {
  return get('/judge/selfcheck');
}

/** 单档（规则 / 深判）的判决计数。unit = 行：一次深判 = 一行 = 一个样本。 */
export interface KernelTierBucket {
  runs: number;
  pass: number;
  fail: number;
  inconclusive: number;
  lastRunId: number | null;
  lastCreatedAt: number | null;
}

/**
 * 强化内核洞察视图。
 *
 * 四块内容各自有口径陷阱，前端渲染时必须带说明：
 *  - `distribution.deep.runs` 是**行数**，不等于被深判的原判决数（要配合 coveredOriginals 读）；
 *  - `deepUsage.totalTokens` 只是「已落库深判行」的花费，**不计入会话 token 预算**，
 *    且只统计最近 200 条（`deepTruncated` 为真时必须在界面上写出来）；
 *  - `injection.chars` 是实际注入字符（含序号前缀），`policyLessons` 才是存储条数；
 *  - `lastRunCoverage` 为 null 表示「没有快照」，**不是 0%**。
 */
export interface KernelInsight {
  generatedAt: number;
  window: {
    limit: number;
    runsScanned: number;
    runsTruncated: boolean;
    deepScanLimit: number;
    deepScanned: number;
    deepTruncated: boolean;
  };
  layers: {
    canary: { status: JudgeVerdictStatus; goodScore: number; badScore: number; detail: string };
    coverageThreshold: number;
    items: Array<{
      layer: JudgeLayerId;
      available: boolean;
      required: boolean;
      reason: string | null;
      detail: string | null;
      lastRunCoverage: number | null;
    }>;
    unavailableLayers: Array<{ layer: JudgeLayerId; reason: string }>;
  };
  distribution: {
    unit: 'row';
    rules: KernelTierBucket;
    deep: KernelTierBucket & { coveredOriginals: number; repeatParents: number };
    totalRuns: number;
  };
  deepUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    rowsWithUsage: number;
    rowsWithoutUsage: number;
    avgLatencyMs: number | null;
    failures: Record<string, number>;
    byModel: Array<{ model: string; runs: number; promptTokens: number; completionTokens: number }>;
  };
  injection: {
    version: number;
    lessons: string[];
    evicted: string[];
    chars: number;
    policyLessons: number;
    budget: { maxLessons: number; maxChars: number } | null;
  } | null;
  errors: string[];
}

export async function getKernelInsight(limit = 50): Promise<KernelInsight> {
  return get(`/judge/insight?limit=${limit}`);
}

/** GET /api/v1/judge/effectiveness —— π 经验有效性聚合。 */
export async function getJudgeEffectiveness(): Promise<LessonEffectivenessRow[]> {
  const res = await get<{ lessons: LessonEffectivenessRow[] }>('/judge/effectiveness');
  return res.lessons;
}
