/**
 * Policy controller —— π 版本面的只读历史 + 一个受限写操作（回滚）。
 *
 * 为什么回滚是「写」却只有它一个：
 *  - π 的自我修改必须由 Judge 判决驱动（r → Update），HTTP 面**不允许**直接塞经验；
 *  - 回滚不是「再创作一个 π」，而是「把历史某一版原样追加为最新版」——
 *    历史不可变（append-only），回滚本身也是一条可审计记录，因此它可以被人工发起。
 *
 * 边界：
 *  - 回滚必须显式给出目标版本，不做「回滚一步」的隐式语义（隐式无法审计）；
 *  - 目标版本不存在 → 404；参数非法 → 400；回滚成功 → 200 返回**新的当前版本号**。
 */

import type { Request, Response } from 'express';
import type { UpdateService } from '../services/agent/update.service.js';
import { diffPolicyVersions } from '../services/agent/policy-diff.js';
import type { Policy } from '../repositories/policy.repository.js';

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

export interface PolicyVersionView {
  version: number;
  parentVersion: number | null;
  sourceJudgment: string | null;
  createdAt: number;
  /** 是否为当前生效版本。 */
  current: boolean;
  lessonCount: number;
  diff: ReturnType<typeof diffPolicyVersions>;
}

export class PolicyController {
  constructor(private readonly policy: UpdateService) {}

  /**
   * GET /api/v1/policy/versions?limit=20
   *
   * 仓储返回全部版本（升序），这里从最新往回取 limit 条并逐条算 diff。
   * 截断放在 controller 而不是 repo：repo.listVersions 是「全量历史」口径，
   * 被 replay/审计复用；给它加 limit 会改变那两处的语义。
   */
  listVersions(req: Request, res: Response): void {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;

    const rows = this.policy.listVersions();
    const currentVersion = this.policy.currentVersion();

    const parsed: Array<{ version: number; parentVersion: number | null; sourceJudgment: string | null; createdAt: number; policy: Policy }> = [];
    for (const row of rows) {
      try {
        parsed.push({
          version: row.version,
          parentVersion: row.parentVersion,
          sourceJudgment: row.sourceJudgment,
          createdAt: row.createdAt,
          policy: JSON.parse(row.policyJson) as Policy,
        });
      } catch {
        // 坏 JSON 行不展示（展示半条 diff 等于误导），由版本号缺口暴露问题。
        continue;
      }
    }

    const byVersion = new Map(parsed.map((p) => [p.version, p]));
    const views: PolicyVersionView[] = parsed
      .slice(-limit)
      .reverse()
      .map((entry) => {
        const prev = entry.parentVersion !== null ? byVersion.get(entry.parentVersion) : undefined;
        return {
          version: entry.version,
          parentVersion: entry.parentVersion,
          sourceJudgment: entry.sourceJudgment,
          createdAt: entry.createdAt,
          current: entry.version === currentVersion,
          lessonCount: entry.policy.lessons.length,
          diff: diffPolicyVersions(prev?.policy ?? null, entry.policy),
        };
      });

    res.json({ versions: views, currentVersion, total: parsed.length });
  }

  /**
   * POST /api/v1/policy/rollback  body: { version: number }
   *
   * 回滚 = 追加一个内容等于目标版的新版本（UpdateService.rollbackTo 的语义）。
   * 不提供「删版本」：历史是审计链，删除即篡改。
   */
  rollback(req: Request, res: Response): void {
    const raw = (req.body ?? {}) as { version?: unknown };
    const version = Number(raw.version);
    if (!Number.isInteger(version) || version < 1) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'version 必须是正整数（目标 π 版本号）' },
      });
      return;
    }
    try {
      this.policy.rollbackTo(version);
      res.json({ rolledBackTo: version, currentVersion: this.policy.currentVersion() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('POLICY_VERSION_NOT_FOUND')) {
        res.status(404).json({
          error: { code: 'POLICY_VERSION_NOT_FOUND', message: `π 版本 v${version} 不存在` },
        });
        return;
      }
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: `回滚失败：${message}` } });
    }
  }
}