/**
 * Trace repository — 运行轨迹（span）的持久化面。
 *
 * 两张表各司其职：
 *  - agent_traces      一次 Agent 运行的汇总（状态 / span 数 / 起止时间）
 *  - agent_trace_spans 运行过程中产生的动作节点（act / judge / update）
 *
 * 与 judge_* 的刻意差别：轨迹随会话删除而级联清理（`ON DELETE CASCADE`）。
 * 判决是「证据」，会话没了也要留着复盘；轨迹是「过程回放」，会话没了它就没有
 * 回放的对象 —— 留着它只会变成无人认领的孤儿数据。
 *
 * 本文件只放 SQL 与行结构。seq 的分配与 span_count 的自增属于业务语义，
 * 住在 service（它要连同事务边界一起管），仓储不做编号决策。
 */

import type { Db } from './db.js';
import type { TraceSpanKind, TraceSpanStatus, TraceStatus } from '../services/observability/trace.service.js';

/** agent_traces 行结构（与表列一一对应，snake_case 保持与 SQL 一致）。 */
export interface TraceRow {
  id: string;
  session_id: string;
  root_name: string;
  status: TraceStatus;
  span_count: number;
  started_at: number;
  ended_at: number | null;
}

/** agent_trace_spans 行结构。 */
export interface TraceSpanRow {
  id: string;
  trace_id: string;
  seq: number;
  kind: TraceSpanKind;
  name: string;
  status: TraceSpanStatus;
  detail: string | null;
  duration_ms: number;
  created_at: number;
}

export interface InsertTraceInput {
  id: string;
  sessionId: string;
  rootName: string;
  startedAt: number;
}

export interface InsertSpanInput {
  id: string;
  traceId: string;
  seq: number;
  kind: TraceSpanKind;
  name: string;
  status: TraceSpanStatus;
  detail: string | null;
  durationMs: number;
  createdAt: number;
}

export class TraceRepository {
  constructor(private readonly db: Db) {}

  /** 开一条新轨迹。状态恒为 running，span_count 从 0 起。 */
  insertTrace(input: InsertTraceInput): void {
    this.db.run(
      `INSERT INTO agent_traces (id, session_id, root_name, status, span_count, started_at, ended_at)
       VALUES (?, ?, ?, 'running', 0, ?, NULL)`,
      [input.id, input.sessionId, input.rootName, input.startedAt],
    );
  }

  getTrace(id: string): TraceRow | undefined {
    return this.db.get<TraceRow>(`SELECT * FROM agent_traces WHERE id = ?`, [id]);
  }

  /**
   * 最近的轨迹列表（新的在前）。
   *
   * 排序键是 started_at DESC；同毫秒内并列时用 rowid DESC 兜底 ——
   * 不加这个二级键的话，同一批启动的轨迹顺序取决于 SQLite 的执行计划，
   * 前端每次刷新看到的顺序可能不同。
   */
  listTraces(limit: number): TraceRow[] {
    return this.db.all<TraceRow>(
      `SELECT * FROM agent_traces ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      [limit],
    );
  }

  /** 写一条 span。调用方负责保证 seq 唯一且 span_count 同步更新。 */
  insertSpan(input: InsertSpanInput): void {
    this.db.run(
      `INSERT INTO agent_trace_spans (id, trace_id, seq, kind, name, status, detail, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.traceId,
        input.seq,
        input.kind,
        input.name,
        input.status,
        input.detail,
        input.durationMs,
        input.createdAt,
      ],
    );
  }

  /** 某条轨迹的全部 span，按 seq 升序（= 发生顺序）。 */
  listSpans(traceId: string): TraceSpanRow[] {
    return this.db.all<TraceSpanRow>(
      `SELECT * FROM agent_trace_spans WHERE trace_id = ? ORDER BY seq ASC`,
      [traceId],
    );
  }

  /** 回写 span_count：它必须恒等于该轨迹已写入的 span 条数。 */
  setSpanCount(traceId: string, spanCount: number): void {
    this.db.run(`UPDATE agent_traces SET span_count = ? WHERE id = ?`, [spanCount, traceId]);
  }

  /**
   * 结束一条轨迹，只改仍在 running 的行。
   *
   * 「先到先得」而不是「后到覆盖」：轨迹一旦定局（ok / error）就是既成事实，
   * 迟到的收尾调用不该把已 ok 的轨迹改判成 error —— 那会让回放结论不可信。
   *
   * @returns 实际更新到的行数（0 = 轨迹不存在或已定局）
   */
  endTrace(traceId: string, status: 'ok' | 'error', endedAt: number): number {
    const result = this.db.run(
      `UPDATE agent_traces SET status = ?, ended_at = ? WHERE id = ? AND status = 'running'`,
      [status, endedAt, traceId],
    );
    return result.changes;
  }
}
