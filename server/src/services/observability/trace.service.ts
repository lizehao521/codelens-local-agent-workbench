/**
 * Trace service — 运行轨迹（trace）的记录与查询面。
 *
 * 它回答一个问题：**这一轮 Agent 到底发生了什么。**
 * 一次运行被拆成一串有序的 span：
 *  - act    一次工具动作（Act）
 *  - judge  一次判决（Judge）
 *  - update 一次策略更新（Update）
 *
 * 设计上只有一条硬规矩：**观测面不能成为新的故障点。**
 * 埋点代码跑在主链路上（工具调用、判决、策略更新都会经过它），它一旦抛错，
 * 就会把「想看看刚才发生了什么」变成「刚才那次运行失败了」。所以：
 *  - 未启用（config.observabilityEnabled = false）时一律返回 null / 空数组，不抛错；
 *  - 未知 traceId 静默返回 null，不抛错；
 *  - 任何未预期的 DB 异常都被收成 null / 空数组，不向上冒泡。
 *
 * 写入侧只有三个入口（startTrace / recordSpan / endTrace），由运行时在
 * agent-loop 里调用；读取侧两个（list / getSpans）供只读面板使用。
 */

import { randomUUID } from 'node:crypto';
import type { Db } from '../../repositories/db.js';
import { TraceRepository, type TraceRow, type TraceSpanRow } from '../../repositories/trace.repository.js';

/** span 的三种类型：Act（工具动作）/ Judge（判决）/ Update（策略更新）。 */
export type TraceSpanKind = 'act' | 'judge' | 'update';

/** 轨迹状态：running（进行中）/ ok（正常收尾）/ error（异常收尾）。 */
export type TraceStatus = 'running' | 'ok' | 'error';

/** 单个 span 的状态。 */
export type TraceSpanStatus = 'ok' | 'error';

/** 一条 span 的领域对象（字段名 camelCase，与 HTTP 响应一致）。 */
export interface TraceSpan {
  spanId: string;
  traceId: string;
  /** 在本轨迹内的序号，从 1 开始，等于写入顺序。 */
  seq: number;
  kind: TraceSpanKind;
  name: string;
  status: TraceSpanStatus;
  detail?: string;
  durationMs: number;
  createdAt: number;
}

/** 一条轨迹的摘要（列表视图）。 */
export interface TraceSummary {
  traceId: string;
  sessionId: string;
  rootName: string;
  status: TraceStatus;
  /** 已写入的 span 条数，与 agent_traces.span_count 同源。 */
  spanCount: number;
  startedAt: number;
  /** 未结束时为 undefined（轨迹仍在 running）。 */
  endedAt?: number;
}

/** 记录一条 span 时的入参：序号与时间由服务内部维护，调用方不传。 */
export interface RecordSpanInput {
  kind: TraceSpanKind;
  name: string;
  status?: TraceSpanStatus;
  detail?: string;
  durationMs?: number;
}

/** 列表默认条数。 */
export const DEFAULT_TRACE_LIMIT = 50;

/** 列表条数硬上限：一次拉爆内存是只读面板最容易被顺手触发的事。 */
export const MAX_TRACE_LIMIT = 200;

const SPAN_KINDS: ReadonlySet<string> = new Set<string>(['act', 'judge', 'update']);

/**
 * limit 的唯一收敛点。
 *
 * 非法值（非数字、NaN、≤0）一律回落到默认值；超上限截到上限。
 * 收敛只在这里做，controller / repository 都不再重复判断 —— 口径分散就会出现
 * 「前端传 0 拿到 50、另一处传 0 拿到空数组」这种对不上的现象。
 */
function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TRACE_LIMIT;
  const truncated = Math.trunc(n);
  if (truncated <= 0) return DEFAULT_TRACE_LIMIT;
  return Math.min(MAX_TRACE_LIMIT, truncated);
}

/** 耗时归一：负数 / 非法值一律记 0，绝不写负耗时。 */
function normalizeDuration(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

/**
 * span 明细的长度上限。
 *
 * 截断收在**服务层**而不是各调用方：调用方有五处（工具结果、判决摘要、策略增量…），
 * 各自截断迟早会出现「有的截了有的没截」，而轨迹是长期留存的数据 ——
 * 一段没截断的模型输出就能把整张表撑大几十倍。
 */
const DETAIL_MAX = 500;

function normalizeDetail(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const text = String(raw);
  if (text.length === 0) return null;
  return text.length <= DETAIL_MAX ? text : `${text.slice(0, DETAIL_MAX)}…（已截断）`;
}

function toSummary(row: TraceRow): TraceSummary {
  return {
    traceId: row.id,
    sessionId: row.session_id,
    rootName: row.root_name,
    status: row.status,
    spanCount: row.span_count,
    startedAt: row.started_at,
    // 未结束的轨迹不报 endedAt（而不是报 0 / null）——「没结束」与「结束时点是 0」是两回事。
    ...(row.ended_at === null || row.ended_at === undefined ? {} : { endedAt: row.ended_at }),
  };
}

function toSpan(row: TraceSpanRow): TraceSpan {
  return {
    spanId: row.id,
    traceId: row.trace_id,
    seq: row.seq,
    kind: row.kind,
    name: row.name,
    status: row.status,
    ...(row.detail === null || row.detail === undefined ? {} : { detail: row.detail }),
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

export class TraceService {
  private readonly db: Db;
  private readonly observabilityEnabled: boolean;
  private readonly repo: TraceRepository;

  constructor(opts: { db: Db; enabled: boolean }) {
    this.db = opts.db;
    this.observabilityEnabled = opts.enabled;
    this.repo = new TraceRepository(opts.db);
  }

  /** 观测面是否启用。控制器用它决定响应里的 `enabled` 字段。 */
  get enabled(): boolean {
    return this.observabilityEnabled;
  }

  /**
   * 开一条新轨迹。
   *
   * @returns 轨迹摘要；未启用或写入失败时返回 null（绝不抛错打断主链路）。
   */
  startTrace(sessionId: string, rootName: string): TraceSummary | null {
    if (!this.observabilityEnabled) return null;
    try {
      const traceId = randomUUID();
      const startedAt = Date.now();
      const root = typeof rootName === 'string' ? rootName : '';
      this.repo.insertTrace({ id: traceId, sessionId, rootName: root, startedAt });
      return {
        traceId,
        sessionId,
        rootName: root,
        status: 'running',
        spanCount: 0,
        startedAt,
      };
    } catch {
      // 观测面不能成为新的故障点：起轨迹失败就当没有轨迹，主链路继续跑。
      return null;
    }
  }

  /**
   * 记录一条 span。
   *
   * seq 由服务内部按当前轨迹的 span_count 递增分配，并与 span_count 的回写
   * 放在**同一个事务**里：span 与计数要么一起进去，要么都不进去。
   * 因此不变式恒为 `span_count = 该轨迹的 span 条数 = 最大 seq`。
   *
   * 降级规则（都不抛错）：
   *  - 未启用 → null
   *  - traceId 为空或不存在 → null
   *  - kind 非法（不在 act/judge/update 内）→ null，且不写任何行
   */
  recordSpan(traceId: string, span: RecordSpanInput): TraceSpan | null {
    if (!this.observabilityEnabled) return null;
    if (!traceId) return null;
    // 非法 kind 一律拒绝（返回 null）而不是抛错：与整条链路「观测不打断主流程」
    // 的约定一致，代价是调用方拿不到 span —— 但那本来就比写脏数据好。
    if (!span || !SPAN_KINDS.has(span.kind)) return null;

    try {
      const kind = span.kind;
      const name = typeof span.name === 'string' ? span.name : '';
      const status: TraceSpanStatus = span.status === 'error' ? 'error' : 'ok';
      const durationMs = normalizeDuration(span.durationMs);
      const detail = normalizeDetail(span.detail);
      const spanId = randomUUID();
      const createdAt = Date.now();

      return this.db.transaction((): TraceSpan | null => {
        const trace = this.repo.getTrace(traceId);
        // 未知 traceId：静默丢弃。这条轨迹可能已经被清理，或调用方拿到了脏 id；
        // 两种情况都不该让主链路报错。
        if (!trace) return null;

        const seq = trace.span_count + 1;
        this.repo.insertSpan({
          id: spanId,
          traceId,
          seq,
          kind,
          name,
          status,
          detail,
          durationMs,
          createdAt,
        });
        this.repo.setSpanCount(traceId, seq);

        return {
          spanId,
          traceId,
          seq,
          kind,
          name,
          status,
          ...(detail === null ? {} : { detail }),
          durationMs,
          createdAt,
        };
      });
    } catch {
      return null;
    }
  }

  /**
   * 结束一条轨迹。
   *
   * 先到先得：已定局的轨迹不会被后来的调用改判（见 repository.endTrace）。
   * 未启用 / 轨迹不存在时静默返回，不抛错。
   */
  endTrace(traceId: string, status: 'ok' | 'error'): void {
    if (!this.observabilityEnabled) return;
    if (!traceId) return;
    try {
      this.repo.endTrace(traceId, status === 'error' ? 'error' : 'ok', Date.now());
    } catch {
      // 同上：收尾失败不影响运行结果。
    }
  }

  /**
   * 最近的轨迹列表（新的在前）。
   *
   * @param limit 条数；非法值回落默认 50，超上限截到 200（收敛在 service 内部）。
   */
  list(limit?: number): TraceSummary[] {
    if (!this.observabilityEnabled) return [];
    try {
      return this.repo.listTraces(clampLimit(limit)).map(toSummary);
    } catch {
      return [];
    }
  }

  /** 某条轨迹的 span 明细（按 seq 升序 = 发生顺序）。 */
  getSpans(traceId: string): TraceSpan[] {
    if (!this.observabilityEnabled) return [];
    if (!traceId) return [];
    try {
      return this.repo.listSpans(traceId).map(toSpan);
    } catch {
      return [];
    }
  }
}
