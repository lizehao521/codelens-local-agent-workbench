/**
 * 可编辑计划面板（P1-4）的 schema 片段。
 *
 * 从 schema.ts 拆出，原因：schema.ts 受"只许缩不许涨"的文件行数棘轮约束
 * （ceiling 606），plan 表 DDL + migration 记账会把主 schema 撑过上限。
 * plan 本就有独立 repository，DDL 独立成文件也符合"一表一模块"的架构。
 *
 * 本文件导出纯字符串片段与 migration 应用函数，由 schema.ts 组装进
 * SCHEMA_SQL / applyMigrations，保持单一事实来源（EXPECTED_TABLE_COUNT 从
 * 最终拼好的 SCHEMA_SQL 计算，自动包含本表）。
 */

/** plan 表的 CREATE TABLE + INDEX DDL（插入到 SCHEMA_SQL 末尾）。 */
export const PLAN_SCHEMA_DDL = `
-- ── 可编辑计划面板（P1-4）───────────────────────────────────────────────────
-- 一次 run 的多步计划：用户可在执行前查看/改步骤/删步骤/重排，Agent 执行时读编辑后的版本。
-- plan 属于某个会话（级联删除）；steps_json 是步骤数组的 JSON 原文（编解码在 service）。
-- status: draft=编辑中 / approved=已确认待执行 / running=执行中 / done=已完成 / cancelled=已取消。
CREATE TABLE IF NOT EXISTS agent_plans (
  id          TEXT    PRIMARY KEY,
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id      TEXT,
  title       TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'approved', 'running', 'done', 'cancelled')),
  steps_json  TEXT    NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_plans_session ON agent_plans(session_id, created_at DESC);
`;

/** applyMigrations 的最小 DB 表面（与 schema.ts 的 MigrationDb 结构兼容）。 */
export interface PlanMigrationDb {
  exec(sql: string): void;
  get<T>(sql: string): T | undefined;
  run(sql: string, params: unknown[]): void;
}

/**
 * 应用 plan 表的 migration 记账（version=8）。
 * 新表已由 SCHEMA_SQL 的 CREATE TABLE IF NOT EXISTS 幂等建出；
 * 这里显式保证索引 + 版本记账，旧库升上来后不会漏。
 * @returns 若本次新应用了 version=8 则返回 [8]，否则返回空数组。
 */
export function applyPlanMigration(db: PlanMigrationDb): number[] {
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_plans_session ON agent_plans(session_id, created_at DESC)');
  const v8 = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 8');
  if ((v8?.n ?? 0) === 0) {
    db.run(
      `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (8, '008-editable-plan-panel', ?)`,
      [Date.now()],
    );
    return [8];
  }
  return [];
}
