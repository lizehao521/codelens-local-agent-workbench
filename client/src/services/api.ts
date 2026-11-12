// API 封装 —— 所有后端调用集中于此（docs/agent/spec.md §5 端点清单，22 个可调用端点）

import type {
  ApprovalSubmitRequest,
  McpServer,
  Provider,
  SessionDetail,
  ResumeResponse,
  RunAuditResponse,
  SessionListResponse,
  ServerSession,
  ToolDefinitionPublic,
} from '../types';

const BASE = '/api/v1';

/**
 * 拼查询串：跳过 undefined 与空串，返回带 `?` 的后缀（无参数时原样返回 path）。
 *
 * 此前每个带参数的端点都手写一遍「建 qs → set → toString → 判断有无 ?」，
 * 四份几乎一模一样；而漏掉空值判断就会发出 `?limit=undefined` 这类请求 ——
 * 服务端要额外做一次解析容错才能不报错。空串同样跳过：`?q=` 与不带 q 语义不同。
 */
function withQuery(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const text = String(value);
    if (text.length === 0) continue;
    qs.set(key, text);
  }
  const suffix = qs.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export class ApiError extends Error {
  code: string;
  status: number;
  /** 422 时携带被拒目录及原因（沙箱权限），便于前端高亮。 */
  rejected?: Array<{ dir: string; error: string }>;
  constructor(code: string, message: string, status: number, rejected?: Array<{ dir: string; error: string }>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.rejected = rejected;
  }
}

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|authorization)/i;

/**
 * 递归打码疑似密钥字段：字段名匹配 apiKey/token/secret/password/authorization 时值置为脱敏占位。
 * 用于任何可能进入日志 / UI 的接口载荷，避免 API Key 经错误响应泄露（F-02）。
 */
function redactSecrets<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(
      /(api[_-]?key|secret|token|password|authorization)\s*[:=]\s*\S+/gi,
      '$1: ***REDACTED***',
    ) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = Array.isArray(value)
      ? ([] as unknown as Record<string, unknown>)
      : {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k) && typeof v === 'string') out[k] = '***REDACTED***';
      else out[k] = redactSecrets(v);
    }
    return out as T;
  }
  return value;
}

async function parseErrorResponse(res: Response): Promise<ApiError> {
  try {
    const raw = (await res.json()) as {
      error?: { code?: string; message?: string } | string;
      message?: string;
      rejected?: Array<{ dir: string; error: string }>;
    };
    // 服务端错误体可能回显含密钥的上下文，先整体脱敏再取值。
    const data = redactSecrets(raw);
    if (data && typeof data.error === 'object' && data.error !== null) {
      const code = data.error.code ?? `HTTP_${res.status}`;
      const message = data.error.message ?? `请求失败（HTTP ${res.status}）`;
      return new ApiError(code, message, res.status, data.rejected);
    }
    const code = typeof data.error === 'string' ? data.error : `HTTP_${res.status}`;
    const message = data.message ?? `请求失败（HTTP ${res.status}）`;
    return new ApiError(code, message, res.status, data.rejected);
  } catch {
    return new ApiError(`HTTP_${res.status}`, `请求失败（HTTP ${res.status}）`, res.status);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw await parseErrorResponse(res);
  return (await res.json()) as T;
}

async function send<T>(path: string, body?: unknown, method = 'POST', deviceToken?: string | null): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (deviceToken) headers['X-Device-Token'] = deviceToken;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await parseErrorResponse(res);
  return (await res.json()) as T;
}

// ── 健康与 Provider ─────────────────────────────────────────

/** GET /api/health —— StatusBar 连接状态点（含 db/mcp/sandbox） */
export async function getHealth(): Promise<{
  status: string;
  db: { ok: boolean };
  mcp: { servers: number; healthy: number };
}> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new ApiError(`HTTP_${res.status}`, '健康检查失败', res.status);
  return (await res.json()) as {
    status: string;
    db: { ok: boolean };
    mcp: { servers: number; healthy: number };
  };
}

/** GET /api/v1/providers —— provider 与模型列表（不含 Key） */
export async function getProviders(): Promise<Provider[]> {
  const data = await get<{ providers?: Provider[] }>('/providers');
  return data.providers ?? [];
}

/** GET /api/v1/providers/capabilities —— 能力探测合并视图（AC-01） */
export async function getProviderCapabilities(): Promise<{
  capabilities: Array<{
    provider: string;
    model: string;
    supportsFunctionCalling: boolean | null;
    probeStatus: string;
    contextWindow: number | null;
    lightweightModel: string | null;
    probedAt: number | null;
    notes: string | null;
  }>;
}> {
  return get('/providers/capabilities');
}

/** GET /api/v1/providers/sync-status —— 最近一次上游模型同步状态与最近日志 */
export async function getProviderSyncStatus(): Promise<{
  sync: {
    lastRunAt: number | null;
    lastStatus: string;
    lastError: string | null;
    lastProviderCount: number | null;
    lastModelCount: number | null;
    sourceUrl: string;
  };
  recentLogs: Array<{
    id: number;
    occurred_at: number;
    status: string;
    attempt: number;
    message: string;
    detail: string | null;
    source_url: string;
  }>;
}> {
  return get('/providers/sync-status');
}

// ── 会话（服务端持久化 + 恢复码） ────────────────────────────

/** GET /api/v1/sessions —— 列表（带 X-Device-Token 时只返回本设备会话） */
export async function listSessions(deviceToken?: string | null): Promise<SessionListResponse> {
  const res = await fetch(`${BASE}/sessions?limit=100`, {
    headers: deviceToken ? { 'X-Device-Token': deviceToken } : undefined,
  });
  if (!res.ok) throw await parseErrorResponse(res);
  return (await res.json()) as SessionListResponse;
}

/** POST /api/v1/sessions —— 创建；recoveryCode 只此一次明文 */
export async function createSession(input: {
  provider: string;
  model: string;
  title?: string;
}): Promise<{ session: ServerSession; recoveryCode: string; deviceToken: string }> {
  return send('/sessions', input);
}

/** GET /api/v1/sessions/:id —— 详情（消息 + 工具调用 + 审批） */
export async function getSessionDetail(
  sessionId: string,
  deviceToken?: string | null,
): Promise<SessionDetail> {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}`, {
    headers: deviceToken ? { 'X-Device-Token': deviceToken } : undefined,
  });
  if (!res.ok) throw await parseErrorResponse(res);
  return (await res.json()) as SessionDetail;
}

/** PATCH /api/v1/sessions/:id —— 重命名 / 改模型 */
export async function patchSession(
  sessionId: string,
  patch: { title?: string; model?: string; channelMode?: 'auto' | 'native' | 'react' },
  deviceToken?: string | null,
): Promise<{ session: ServerSession }> {
  return send(`/sessions/${encodeURIComponent(sessionId)}`, patch, 'PATCH', deviceToken);
}

/** DELETE /api/v1/sessions/:id —— 删除（级联） */
export async function deleteSession(sessionId: string, deviceToken?: string | null): Promise<void> {
  await send(`/sessions/${encodeURIComponent(sessionId)}`, undefined, 'DELETE', deviceToken);
}

/** POST /api/v1/sessions/:id/recovery-code —— 重生成（旧码立即失效） */
export async function regenerateRecoveryCode(sessionId: string): Promise<{ recoveryCode: string }> {
  return send(`/sessions/${encodeURIComponent(sessionId)}/recovery-code`, {});
}

/** POST /api/v1/sessions/recover —— 恢复码换回会话（旧码立即失效） */
export async function recoverSession(recoveryCode: string, deviceToken: string): Promise<{
  session: ServerSession;
  deviceToken: string;
}> {
  return send('/sessions/recover', { recoveryCode, deviceToken });
}

// ── 工具注册表 ──────────────────────────────────────────────

/** GET /api/v1/tools —— 双轨名 + 风险分组 */
export async function listTools(): Promise<{
  tools: ToolDefinitionPublic[];
  grouped: Record<'low' | 'medium' | 'high', string[]>;
}> {
  return get('/tools');
}

/** PATCH /api/v1/tools/:name —— 启用 / 禁用 */
export async function patchTool(name: string, enabled: boolean): Promise<{ name: string; enabled: boolean }> {
  return send(`/tools/${encodeURIComponent(name)}`, { enabled }, 'PATCH');
}

// ── 审批（独立端点，不走 SSE 同流） ─────────────────────────

/** POST /api/v1/approvals/:id —— 三值决定（.strict()：body 出现 arguments 一律 400） */
export async function submitApproval(approvalId: string, body: ApprovalSubmitRequest): Promise<{ ok: true }> {
  return send(`/approvals/${encodeURIComponent(approvalId)}`, body);
}

/** POST /api/v1/approvals/:id/revise —— AC-10 改参数重试（唯一可带 arguments 的端点） */
export async function reviseApproval(
  approvalId: string,
  token: string,
  args: Record<string, unknown>,
): Promise<{ ok: true }> {
  return send(`/approvals/${encodeURIComponent(approvalId)}/revise`, { token, arguments: args });
}

/** POST /api/v1/approvals/:id/reissue —— AUDIT-009 续期（重新签发未过期令牌，延长 5 分钟） */
export async function reissueApproval(
  approvalId: string,
  token: string,
): Promise<{ ok: true; approvalId: string; approvalToken: string; expiresAt: number }> {
  return send(`/approvals/${encodeURIComponent(approvalId)}/reissue`, { token });
}

// ── Agent 运行控制 ─────────────────────────────────────────

/**
 * POST /api/v1/agent/abort —— 服务端直停当前会话的运行（P1-6）。
 * 本地 abort() 经「断开→res.close」也能停，但该端点不等 TCP 关闭传播到
 * AbortRegistry，且跨标签页（本页无活跃 controller）时是唯一入口。
 * aborted=false 表示该会话当前没有在跑的任务（幂等无害）。
 */
export async function abortAgentRun(sessionId: string): Promise<{ ok: boolean; aborted: boolean }> {
  return send('/agent/abort', { sessionId });
}

/** 兜底 Key 试用/预算状态（按请求 IP）。 */
export interface TrialStatus {
  enabled: boolean;
  trialModeEnabled: boolean;
  serverKeyConfigured: boolean;
  dailyLimit: number | null;
  usedRuns: number;
  remainingRuns: number | null;
  perTaskTokenLimit: number;
  budgetExceeded: boolean;
  budgetReason: 'trial_exhausted' | 'global_budget_exhausted' | 'per_ip_budget_exhausted' | null;
  /** 试用锁定的上游（未启用试用锁定时为 null）。只含地址与模型，不含密钥。 */
  trialUpstream: {
    provider: string;
    model: string;
    baseUrl: string | null;
    /** R4：真实最小生成探测的三态结果（ok / auth_failed / unreachable）。 */
    health: {
      status: 'unknown' | 'ok' | 'auth_failed' | 'unreachable';
      detail: string | null;
      checkedAt: number | null;
      durationMs: number | null;
      tokens: { promptTokens: number; completionTokens: number } | null;
      cached: boolean;
    };
  } | null;
}

/** GET /api/v1/agent/trial-status —— 前端无 Key 引导条据此展示试用剩余次数。 */
export async function getTrialStatus(): Promise<TrialStatus> {
  return get('/agent/trial-status');
}

// ── MCP 连接器（P1） ────────────────────────────────────────

export async function listMcpServers(): Promise<{ servers: McpServer[] }> {
  return get('/mcp/servers');
}

export async function createMcpServer(input: {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}): Promise<{ server: McpServer }> {
  return send('/mcp/servers', input);
}

export async function patchMcpServer(
  id: string,
  patch: { name?: string; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean },
): Promise<{ server: McpServer }> {
  return send(`/mcp/servers/${encodeURIComponent(id)}`, patch, 'PATCH');
}

export async function deleteMcpServer(id: string): Promise<void> {
  await send(`/mcp/servers/${encodeURIComponent(id)}`, undefined, 'DELETE');
}

export async function connectMcpServer(id: string): Promise<{ status: string; tools: number }> {
  return send(`/mcp/servers/${encodeURIComponent(id)}/connect`, {});
}

export async function disconnectMcpServer(id: string): Promise<{ status: string }> {
  return send(`/mcp/servers/${encodeURIComponent(id)}/disconnect`, {});
}

// ── 沙箱权限（放开沙箱外目录 + 审批豁免；持久化配置） ──

/** 沙箱权限配置：沙箱外允许目录（白名单）+ 自动放行高危操作开关。 */
export interface SandboxPermissionConfig {
  allowDirs: string[];
  autoApprove: {
    fsDestructive: boolean;
    purge: boolean;
    httpWrite: boolean;
  };
}

/** 沙箱权限更新载荷（allowDirs 为完整替换；autoApprove 为部分覆盖）。 */
export interface SandboxPermissionUpdate {
  allowDirs?: string[];
  autoApprove?: {
    fsDestructive?: boolean;
    purge?: boolean;
    httpWrite?: boolean;
  };
}

/** 被拒目录（422）。 */
export interface SandboxPermissionRejected {
  dir: string;
  error: string;
}

/** GET /api/v1/sandbox-permissions —— 当前沙箱权限配置。 */
export async function getSandboxPermissions(): Promise<SandboxPermissionConfig> {
  return get('/sandbox-permissions');
}

/**
 * PUT /api/v1/sandbox-permissions —— 更新（服务端硬校验）。
 * 任一 allowDir 被拒则整体 422 拒绝（不部分写入），rejected 列出被拒目录与原因。
 */
export async function updateSandboxPermissions(input: SandboxPermissionUpdate): Promise<SandboxPermissionConfig> {
  return send('/sandbox-permissions', input, 'PUT');
}

// ── 判据塔（Judge）：只读视图 ─────────────────────────────────────────────
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

// ── 可观测面（能力洞察）：能力目录 / 工作区快照 / 运行轨迹 / 技能库 ──────────

/**
 * 单条运行时能力。
 *
 * `enabled` 与 `wired` 是两件事：enabled = 此刻真的在跑；wired = 该能力对应的
 * 服务已被装配。前端要区分二者，否则「开关是开的但服务没接线」会被显示成正常。
 */
export interface CapabilityEntry {
  id: string;
  label: string;
  enabled: boolean;
  wired: boolean;
  /** 启用方式说明（环境变量名或「内置常开」）。 */
  envHint: string;
  detail?: string;
}

/** 能力开关目录：运维查看「这套系统到底启用了哪些能力」的单一事实来源。 */
export interface CapabilityRegistry {
  capabilities: CapabilityEntry[];
  enabledCount: number;
  total: number;
}

/** GET /api/v1/capabilities —— 能力开关目录（只读）。 */
export async function getCapabilities(): Promise<CapabilityRegistry> {
  return get('/capabilities');
}

/**
 * 工作区快照摘要（不含文件清单，避免把整棵目录树塞进响应体）。
 *
 * `created` / `skipped` 是服务端的额外字段：类型是契约的镜像，缺了等于两边对不上。
 * `skipped` 用来表达"这轮有文件没拍进去"（超限 / 不可读），前端据此提示，
 * 而不是让用户以为快照是完整的。
 */
export interface CheckpointSummary {
  id: string;
  sessionId: string;
  label: string;
  fileCount: number;
  totalBytes: number;
  createdAt: number;
  /** 是否真的落了快照；false = 本轮没有可拍的文件（空快照不落库）。 */
  created?: boolean;
  /** 被跳过的文件数与原因分布（maxFiles / maxBytes / unreadable 等）。 */
  skipped?: { count: number; reasons: Record<string, number> };
}

/**
 * GET /api/v1/checkpoints —— 工作区快照清单（只读）。
 *
 * `enabled=false` 表示快照能力未开启：此时 checkpoints 为空数组是「没数据」，
 * 不是「没有快照」。
 */
export async function listCheckpoints(
  sessionId?: string,
): Promise<{ enabled: boolean; checkpoints: CheckpointSummary[] }> {
  return get(withQuery('/checkpoints', { sessionId }));
}

/** D：审计台 —— 按 run 取「改了什么 + 来自哪一步」（diff 来自落库快照）。 */
export async function getRunAudit(runId: string): Promise<RunAuditResponse> {
  return get(`/runs/${encodeURIComponent(runId)}/audit`);
}

/**
 * C：按 runId 续跑。409 不是异常而是「冲突/不可续跑」的业务结果，
 * 因此这里不用 `send`（它会丢弃 409 body）。
 */
export async function resumeRun(runId: string): Promise<ResumeResponse> {
  const res = await fetch(`${BASE}/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' });
  const data = (await res.json().catch(() => ({}))) as ResumeResponse;
  if (res.status === 404) return { status: 'not_found' };
  if (res.status === 409) return data.status ? data : { status: 'conflict', conflicts: [] };
  if (!res.ok) throw await parseErrorResponse(res);
  return data;
}

/** D：撤销入口复用既有 checkpoint rollback（run 级 / 文件级 / 单步）。 */
export async function rollbackRun(
  runId: string,
  opts: { step?: number; files?: string[] } = {},
): Promise<{ enabled: boolean; report: unknown }> {
  const res = await fetch(`${BASE}/checkpoints/runs/${encodeURIComponent(runId)}/rollback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-codelens-confirm': 'rollback',
    },
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw await parseErrorResponse(res);
  return (await res.json()) as { enabled: boolean; report: unknown };
}

/** 轨迹 span 的三类：工具动作 / 判决 / 策略更新。 */
export type TraceSpanKind = 'act' | 'judge' | 'update';

export interface TraceSpan {
  spanId: string;
  traceId: string;
  seq: number;
  kind: TraceSpanKind;
  name: string;
  status: 'ok' | 'error';
  detail?: string;
  durationMs: number;
  createdAt: number;
}

export interface TraceSummary {
  traceId: string;
  sessionId: string;
  rootName: string;
  status: 'running' | 'ok' | 'error';
  spanCount: number;
  startedAt: number;
  endedAt?: number;
}

/**
 * GET /api/v1/traces —— 运行轨迹。
 *
 * 带 traceId 取单条明细（返回 spans），不带则取列表（返回 traces）。
 */
export async function listTraces(
  params: { traceId?: string; limit?: number } = {},
): Promise<{ enabled: boolean; traceId?: string; traces: TraceSummary[]; spans: TraceSpan[] }> {
  const res = await get<{
    enabled: boolean;
    traceId?: string;
    traces?: TraceSummary[];
    spans?: TraceSpan[];
  }>(withQuery('/traces', { traceId: params.traceId, limit: params.limit }));
  return { enabled: res.enabled, traces: res.traces ?? [], spans: res.spans ?? [] };
}

/** 技能条目：可复用的解题步骤。 */
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  tags: string[];
  steps: string[];
  matchScore: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * GET /api/v1/skills —— 技能清单或按 q 的语义匹配。
 *
 * 有 q 时服务端返回 mode='match' + matches；无 q 时返回 mode='list' + skills。
 * 两种模式的字段名不同，这里统一成 `skills`（匹配结果即匹配的技能），避免
 * 调用方写两套取值分支。
 */
export async function listSkills(
  params: { q?: string; limit?: number; topK?: number } = {},
): Promise<{ enabled: boolean; mode: 'list' | 'match'; query?: string; skills: SkillDefinition[] }> {
  const res = await get<{
    enabled: boolean;
    mode?: 'list' | 'match';
    query?: string;
    skills?: SkillDefinition[];
    matches?: SkillDefinition[];
  }>(withQuery('/skills', { q: params.q, limit: params.limit, topK: params.topK }));
  return {
    enabled: res.enabled,
    mode: res.mode ?? 'list',
    query: res.query,
    skills: res.matches ?? res.skills ?? [],
  };
}

// ─── RSI 判据读数 ────────────────────────────────────────────────────────
// 数据源：GET /api/rsi/overview?session=<id>（注意：不是 /api/v1 前缀）。
// 服务端返回的是逐会话的判据塔判决 + RSI 代际 + 归因；字段名以实际响应为准，
// 这里统一转成 camelCase，组件层不再接触 snake_case。

// ── 规则契约镜像（Spec §2 逐字段一致，与 server 的 buildRsiRulesContract 同源）──
// 只做类型镜像，不做任何取值加工：overview.rules 与 /api/rsi/rules 都是后端
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
    res = await fetch(`/api/rsi/overview?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
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
 * GET /api/rsi/rules —— 独立规则契约（Spec §3 新增，无需 session）。
 * 与 overview.rules 同源（后端同调 buildRsiRulesContract），供独立看板与
 * 一致性校验脚本消费。失败时抛 ApiError，由调用方降级到兜底契约。
 */
export async function getRsiRules(): Promise<RsiRulesContract> {
  let res: Response;
  try {
    res = await fetch('/api/rsi/rules', { cache: 'no-store' });
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
