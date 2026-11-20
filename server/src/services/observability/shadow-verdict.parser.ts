/**
 * P1 只读消费：跨代影子判决 span 解析器。
 *
 * 消费 recordShadowAudit 经 recordSpan 写入的 5 短键 detail：
 *   { state, verdict, source, reason, hadPrevious }
 *
 * 纯函数、零写入、零副作用。只解析 name==='跨代影子判决' 的 span，
 * 多条时取 seq 最大（最新）一条；所有异常路径返回安全态，永不抛错。
 *
 * 设计：codelens exp163 裁定；代理核对真实 TraceSpan 导出面后机械落地。
 */

import type { TraceSpan, TraceSpanStatus } from './trace.service.js';

/** 解析成功时的判决视图（对应已写入的 5 必需键 + P3 新增的 2 可选键）。 */
export interface ShadowVerdictOk {
  outcome: 'ok';
  state: string;
  verdict: string;
  source: string;
  reason: string;
  hadPrevious: boolean;
  spanId: string;
  traceId: string;
  createdAt: number;
  /** 上一代 generation（P3 起写入）。null=第一代无前世；undefined=历史 span 无此键。 */
  pg?: number | null;
  /** 当前代 generation（P3 起写入）。null=空表无当前代；undefined=历史 span 无此键。 */
  cg?: number | null;
  /**
   * B 项一致性阴影视图（可选）。parser 只做对象浅校验后原样透传，不解析内部结构，
   * 避免 observability 层依赖 rsi 层类型；历史 span 无此键时为 undefined。
   * 结构由 rsi/cross-generation-consistency 的 ConsistencyShadowView 定义。
   */
  consistencyShadow?: Record<string, unknown>;
}

/** 解析失败 / 不可判定。 */
export interface ShadowVerdictFailed {
  outcome: 'failed';
  error: string;
  spanId: string;
  traceId: string;
  createdAt: number;
}

/** 轨迹中不存在影子判决 span。 */
export interface ShadowVerdictAbsent {
  outcome: 'absent';
}

export type ShadowVerdictView =
  | ShadowVerdictOk
  | ShadowVerdictFailed
  | ShadowVerdictAbsent;

const SPAN_NAME = '跨代影子判决';

/** 只消费这些字段，不臆造未写入字段。 */
const REQUIRED_KEYS = ['state', 'verdict', 'source', 'reason', 'hadPrevious'] as const;

/**
 * 从一条轨迹的全部 span 中提取最新的跨代影子判决。
 */
export function parseShadowVerdict(spans: readonly TraceSpan[]): ShadowVerdictView {
  const candidates = spans.filter((s) => s.name === SPAN_NAME);
  if (candidates.length === 0) {
    return { outcome: 'absent' };
  }

  const latest = candidates.reduce((a, b) => (b.seq > a.seq ? b : a));
  const base = {
    spanId: latest.spanId,
    traceId: latest.traceId,
    createdAt: latest.createdAt,
  };

  // error span → 直接失败态（detail 原文保留，便于诊断）。
  if (latest.status === 'error') {
    return {
      outcome: 'failed',
      error: latest.detail ?? 'shadow span status=error, no detail',
      ...base,
    };
  }

  // status=ok → 解析 5 短键 JSON；detail 缺失/非法/字段错位一律安全失败。
  if (!latest.detail) {
    return { outcome: 'failed', error: 'shadow span status=ok but detail is empty', ...base };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(latest.detail);
  } catch {
    return { outcome: 'failed', error: 'detail JSON.parse failed', ...base };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { outcome: 'failed', error: 'detail is not a plain object', ...base };
  }
  const obj = parsed as Record<string, unknown>;

  for (const key of REQUIRED_KEYS) {
    if (!(key in obj)) {
      return { outcome: 'failed', error: `missing required key: ${key}`, ...base };
    }
  }
  if (typeof obj.hadPrevious !== 'boolean') {
    return {
      outcome: 'failed',
      error: `hadPrevious expected boolean, got ${typeof obj.hadPrevious}`,
      ...base,
    };
  }
  for (const key of ['state', 'verdict', 'source', 'reason'] as const) {
    if (typeof obj[key] !== 'string') {
      return { outcome: 'failed', error: `${key} expected string, got ${typeof obj[key]}`, ...base };
    }
  }

  // P3 可选键：存在才校验（历史 span 无 pg/cg 必须继续可解析，不得判 failed）。
  for (const key of ['pg', 'cg'] as const) {
    const value = obj[key];
    if (value !== undefined && value !== null && typeof value !== 'number') {
      return { outcome: 'failed', error: `${key} must be number or null`, ...base };
    }
  }

  return {
    outcome: 'ok',
    state: obj.state as string,
    verdict: obj.verdict as string,
    source: obj.source as string,
    reason: obj.reason as string,
    hadPrevious: obj.hadPrevious as boolean,
    pg: obj.pg === null || typeof obj.pg === 'number' ? obj.pg : undefined,
    cg: obj.cg === null || typeof obj.cg === 'number' ? obj.cg : undefined,
    ...(obj.consistencyShadow !== undefined && typeof obj.consistencyShadow === 'object'
      && obj.consistencyShadow !== null && !Array.isArray(obj.consistencyShadow)
      ? { consistencyShadow: obj.consistencyShadow as Record<string, unknown> }
      : {}),
    ...base,
  };
}

/** 供类型窄化使用的状态常量（避免调用方硬编码字符串）。 */
export const SHADOW_VERDICT_SPAN_NAME = SPAN_NAME;
