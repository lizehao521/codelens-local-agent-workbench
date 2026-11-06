/**
 * Policy repository — the versioned π surface (强化内核宣言第1节).
 *
 * π is the ONLY surface allowed to self-modify, and every mutation must be
 * rollable. We keep the full version history (append-only, never DELETE) so a
 * rollback is itself an auditable record, not a destructive action.
 *
 *   current π' = the row with the MAX version
 *
 * `source_judgment` on each row records which judgment r triggered the change
 * (r must come from a Judge — never from "looks fine").
 */

import type { Db } from './db.js';

export interface Policy {
  /** 经验/提示（π 的「提示」面）：注入下一轮 Act 的 system prompt。 */
  lessons: string[];
  /** 可调阈值（π 的「阈值」面）：预留给后续真实使用者。 */
  thresholds: Record<string, number>;
}

export const EMPTY_POLICY: Policy = { lessons: [], thresholds: {} };

export interface PolicyVersionRow {
  id: number;
  version: number;
  policyJson: string;
  parentVersion: number | null;
  sourceJudgment: string | null;
  createdAt: number;
}

export interface CurrentPolicy {
  policy: Policy;
  version: number;
}

export class PolicyRepository {
  constructor(private readonly db: Db) {}

  /** 当前 π' 与其版本号；无记录时返回 EMPTY_POLICY / version 0。 */
  getCurrent(): CurrentPolicy {
    const row = this.db.get<{ policy_json: string; version: number }>(
      `SELECT policy_json, version FROM policy_versions ORDER BY version DESC LIMIT 1`,
    );
    if (!row) return { policy: EMPTY_POLICY, version: 0 };
    return { policy: JSON.parse(row.policy_json) as Policy, version: row.version };
  }

  getVersion(version: number): Policy | undefined {
    const row = this.db.get<{ policy_json: string }>(
      `SELECT policy_json FROM policy_versions WHERE version = ?`,
      [version],
    );
    return row ? (JSON.parse(row.policy_json) as Policy) : undefined;
  }

  /** 写入一个新版本（version = 当前最大 + 1）。 */
  insertVersion(policy: Policy, parentVersion: number | null, sourceJudgment: string | null): number {
    const version = this.getCurrent().version + 1;
    this.db.run(
      `INSERT INTO policy_versions (version, policy_json, parent_version, source_judgment, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [version, JSON.stringify(policy), parentVersion, sourceJudgment, Date.now()],
    );
    return version;
  }

  listVersions(): PolicyVersionRow[] {
    return this.db.all<PolicyVersionRow>(
      `SELECT id, version, policy_json AS policyJson, parent_version AS parentVersion,
              source_judgment AS sourceJudgment, created_at AS createdAt
       FROM policy_versions ORDER BY version ASC`,
    );
  }
}
