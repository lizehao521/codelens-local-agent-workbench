/**
 * Skill repository — 程序化技能库（skills 表）的持久化面。
 *
 * 一张表只做一件事：把「可复用的解题步骤」按 name 唯一地存下来。
 *
 * 刻意只放 SQL 与行结构：
 *  - JSON 列（tags_json / steps_json）的编解码住在 service —— 只有它知道字段语义；
 *  - 校验（长度 / 字符集 / 密钥拒绝 / 唯一性）住在 service —— 仓储不做业务判断；
 *  - 匹配打分住在 service —— 仓储不该知道「相关度」怎么算。
 *
 * 表结构由 schema.ts 统一定义（含 idx_skills_name），本文件不建表、不加索引。
 */

import type { Db } from './db.js';

/** skills 行结构（与表列一一对应，snake_case 保持与 SQL 一致）。 */
export interface SkillRow {
  id: string;
  name: string;
  description: string;
  tags_json: string;
  steps_json: string;
  match_score: number;
  created_at: number;
  updated_at: number;
}

export interface InsertSkillInput {
  id: string;
  name: string;
  description: string;
  /** 已编码的 JSON 数组字符串（编解码在 service 侧完成）。 */
  tagsJson: string;
  /** 已编码的 JSON 数组字符串。 */
  stepsJson: string;
  matchScore: number;
  createdAt: number;
  updatedAt: number;
}

export class SkillRepository {
  constructor(private readonly db: Db) {}

  insert(input: InsertSkillInput): void {
    this.db.run(
      `INSERT INTO skills (id, name, description, tags_json, steps_json, match_score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.name,
        input.description,
        input.tagsJson,
        input.stepsJson,
        input.matchScore,
        input.createdAt,
        input.updatedAt,
      ],
    );
  }

  /** 按 name 取一条。name 是 UNIQUE 列，故至多一行。 */
  getByName(name: string): SkillRow | undefined {
    return this.db.get<SkillRow>(`SELECT * FROM skills WHERE name = ?`, [name]);
  }

  /**
   * 技能列表（最近更新的在前）。
   *
   * 二级排序键 rowid DESC：同毫秒内更新的多条技能必须有稳定次序，
   * 否则同一批写入的技能每次刷新顺序都可能不同。
   */
  list(limit: number): SkillRow[] {
    return this.db.all<SkillRow>(
      `SELECT * FROM skills ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
      [limit],
    );
  }

  /** 删除一条，返回实际删除的行数（0 = 不存在）。 */
  deleteByName(name: string): number {
    return this.db.run(`DELETE FROM skills WHERE name = ?`, [name]).changes;
  }
}
