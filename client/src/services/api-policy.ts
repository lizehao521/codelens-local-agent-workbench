/**
 * π（策略）版本面 API —— 历史只读 + 回滚（唯一的写操作）。
 *
 * 回滚的语义是「追加一个内容等于目标版的新版本」，历史不可删；
 * 因此这个接口是可逆的：回滚两次就回到了原版本。
 */

import { get, send, withQuery } from './api-http';

export interface PolicyThresholdChange {
  key: string;
  from: number | null;
  to: number | null;
}

export interface PolicyVersionDiff {
  added: string[];
  removed: string[];
  thresholdChanges: PolicyThresholdChange[];
}

export interface PolicyVersionView {
  version: number;
  parentVersion: number | null;
  sourceJudgment: string | null;
  createdAt: number;
  current: boolean;
  lessonCount: number;
  diff: PolicyVersionDiff;
}

export interface PolicyVersionsResponse {
  versions: PolicyVersionView[];
  currentVersion: number;
  total: number;
}

/** GET /api/v1/policy/versions —— π 版本历史（最新在前，含逐版 diff）。 */
export async function getPolicyVersions(limit = 20): Promise<PolicyVersionsResponse> {
  return get<PolicyVersionsResponse>(withQuery('/policy/versions', { limit }));
}

/** POST /api/v1/policy/rollback —— 回滚到指定版本（追加式，可再回滚回来）。 */
export async function rollbackPolicy(version: number): Promise<{ rolledBackTo: number; currentVersion: number }> {
  return send<{ rolledBackTo: number; currentVersion: number }>('/policy/rollback', { version });
}