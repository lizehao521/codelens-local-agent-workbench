// 可观测面：能力目录 / 工作区快照 / 运行轨迹 / 技能库（自 api.ts 拆出）
import type { ResumeResponse, RunAuditResponse } from '../types';
import { BASE, get, parseErrorResponse, withQuery } from './api-http';

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
// 数据源：GET /api/v1/rsi/overview?session=<id>
// （历史：曾走不带版本的前缀 —— /api 下直接挂 rsi/*；2.11 起旧路径仅作兼容转发，
//   前端一律走 /api/v1，与 /api/v1/rsi/iterations 同源同前缀。）
// 服务端返回的是逐会话的判据塔判决 + RSI 代际 + 归因；字段名以实际响应为准，
// 这里统一转成 camelCase，组件层不再接触 snake_case。
