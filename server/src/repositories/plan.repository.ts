/**
 * Plan repository — 可编辑计划面板（agent_plans 表）的持久化面。
 *
 * 刻意只放 SQL 与行结构：
 *  - steps_json 的编解码住在 service —— 只有它知道步骤字段语义；
 *  - 校验（步骤非空/长度/状态流转）住在 service —— 仓储不做业务判断；
 *  - 表结构由 schema.ts 统一定义（含 idx_agent_plans_session），本文件不建表。
 */

import type { Db } from './db.js';

export type PlanStatus = 'draft' | 'approved' | 'running' | 'done' | 'cancelled';

/** agent_plans 行结构（与表列一一对应，snake_case 保持与 SQL 一致）。 */
export interface PlanRow {
  id: string;
  session_id: string;
  run_id: string | null;
  title: string;
  status: PlanStatus;
  steps_json: string;
  created_at: number;
  updated_at: number;
}

export interface InsertPlanInput {
  id: string;
  sessionId: string;
  runId?: string | null;
  title: string;
  status: PlanStatus;
  /** 已编码的 JSON 数组字符串（编解码在 service 侧完成）。 */
  stepsJson: string;
  createdAt: number;
  updatedAt: number;
}

export class PlanRepository {
  constructor(private readonly db: Db) {}

  insert(input: InsertPlanInput): PlanRow {
    this.db.run(
      `INSERT INTO agent_plans (id, session_id, run_id, title, status, steps_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.sessionId,
        input.runId ?? null,
        input.title,
        input.status,
        input.stepsJson,
        input.createdAt,
        input.updatedAt,
      ],
    );
    return this.get(input.id)!;
  }

  get(id: string): PlanRow | undefined {
    return this.db.get<PlanRow>('SELECT * FROM agent_plans WHERE id = ?', [id]);
  }

  /** 按会话列计划（最近创建的在前，同毫秒以 rowid DESC 稳定排序）。 */
  listBySession(sessionId: string, limit: number): PlanRow[] {
    return this.db.all<PlanRow>(
      `SELECT * FROM agent_plans WHERE session_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      [sessionId, limit],
    );
  }

  /** 会话里当前处于「可执行」状态（approved/running）的计划，至多一条。 */
  getActiveBySession(sessionId: string): PlanRow | undefined {
    return this.db.get<PlanRow>(
      `SELECT * FROM agent_plans WHERE session_id = ? AND status IN ('approved', 'running')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [sessionId],
    );
  }

  /** 更新步骤与标题（编辑面板的主写入）；返回实际更新的行数。 */
  updateSteps(id: string, title: string, stepsJson: string, updatedAt: number): number {
    return this.db.run(
      `UPDATE agent_plans SET title = ?, steps_json = ?, updated_at = ? WHERE id = ?`,
      [title, stepsJson, updatedAt, id],
    ).changes;
  }

  /** 状态流转；返回实际更新的行数（0 = 计划不存在或状态不匹配）。 */
  updateStatus(id: string, status: PlanStatus, updatedAt: number): number {
    return this.db.run(
      `UPDATE agent_plans SET status = ?, updated_at = ? WHERE id = ?`,
      [status, updatedAt, id],
    ).changes;
  }

  /** 绑定/解绑 run（执行开始时写入 run_id）。 */
  setRunId(id: string, runId: string | null, updatedAt: number): number {
    return this.db.run(
      `UPDATE agent_plans SET run_id = ?, updated_at = ? WHERE id = ?`,
      [runId, updatedAt, id],
    ).changes;
  }

  delete(id: string): number {
    return this.db.run('DELETE FROM agent_plans WHERE id = ?', [id]).changes;
  }
}
