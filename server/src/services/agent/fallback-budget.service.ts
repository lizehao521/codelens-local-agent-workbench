/**
 * 兜底 Key 试用 + 三级预算闸（A-01 / A-02）。
 *
 * 仅对「使用兜底 Key」的请求生效（BYOK 请求走用户自己的 Key，不做预算闸）。
 * 判定口径与 agent-loop 一致：请求未带 apiKey 且配置了 serverApiKey 才算 fallback。
 *
 * 三级预算：
 *   1. 全局日 token（所有匿名用户合计）；
 *   2. 每 IP 日 token；
 *   3. 单任务 token（覆盖上下文×2 软闸，由 loop 在预算态上覆盖）。
 * 试用量：TRIAL_MODE_ENABLED=true 时，每 IP 每日运行次数 ≤ TRIAL_DAILY_LIMIT。
 *
 * 计数持久化到 SQLite（fallback_usage），进程重启不丢；UTCDay 作为记账周期。
 * 预算额度 0 = 不限（默认全 0 → 与既有「演示模式仅限流」行为完全一致）。
 */

import type { Db } from '../../repositories/db.js';

export interface FallbackBudgetConfig {
  trialEnabled: boolean;
  trialDailyLimit: number;
  globalDailyTokenLimit: number;
  perIpDailyTokenLimit: number;
  perTaskTokenLimit: number;
  serverKeyConfigured: boolean;
}

export interface ReserveResult {
  ok: boolean;
  reason?: 'trial_exhausted' | 'global_budget_exhausted' | 'per_ip_budget_exhausted';
  message?: string;
}

export interface TrialStatus {
  /** 试用模式是否真正可用（开关开启 + 已配置兜底 Key）。 */
  enabled: boolean;
  trialModeEnabled: boolean;
  serverKeyConfigured: boolean;
  /** 每 IP 每日试用次数；null = 不限。 */
  dailyLimit: number | null;
  usedRuns: number;
  /** 剩余次数；null = 不限。 */
  remainingRuns: number | null;
  perTaskTokenLimit: number;
  budgetExceeded: boolean;
  budgetReason: ReserveResult['reason'] | null;
}

interface UsageRow {
  scope: string;
  key: string;
  period_start: number;
  tokens: number;
  runs: number;
  updated_at: number;
}

const DAY_MS = 86_400_000;
const GLOBAL_KEY = 'global';

export class FallbackBudgetService {
  constructor(
    private readonly db: Db,
    private readonly cfg: FallbackBudgetConfig,
  ) {}

  get trialModeEnabled(): boolean {
    return this.cfg.trialEnabled;
  }

  get perTaskTokenLimit(): number {
    return this.cfg.perTaskTokenLimit;
  }

  private dayStart(now: number): number {
    return Math.floor(now / DAY_MS) * DAY_MS;
  }

  private read(scope: 'global' | 'ip', key: string, periodStart: number): UsageRow | undefined {
    return this.db.get<UsageRow>(
      'SELECT scope, key, period_start, tokens, runs, updated_at FROM fallback_usage WHERE scope = ? AND key = ? AND period_start = ?',
      [scope, key, periodStart],
    );
  }

  private add(scope: 'global' | 'ip', key: string, periodStart: number, tokens: number, runs: number): void {
    this.db.run(
      `INSERT INTO fallback_usage (scope, key, period_start, tokens, runs, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, key, period_start) DO UPDATE SET
         tokens = tokens + excluded.tokens,
         runs = runs + excluded.runs,
         updated_at = excluded.updated_at`,
      [scope, key, periodStart, tokens, runs, Date.now()],
    );
  }

  private checkOnly(clientIp: string, now: number): ReserveResult {
    const period = this.dayStart(now);
    const ip = clientIp || 'unknown';
    const ipRow = this.read('ip', ip, period);
    const globalRow = this.read('global', GLOBAL_KEY, period);
    const globalTokens = globalRow?.tokens ?? 0;
    const ipTokens = ipRow?.tokens ?? 0;
    const ipRuns = ipRow?.runs ?? 0;

    if (this.cfg.globalDailyTokenLimit > 0 && globalTokens >= this.cfg.globalDailyTokenLimit) {
      return {
        ok: false,
        reason: 'global_budget_exhausted',
        message: '兜底 Key 今日全局额度已用尽，请配置自己的 API Key',
      };
    }
    if (this.cfg.perIpDailyTokenLimit > 0 && ipTokens >= this.cfg.perIpDailyTokenLimit) {
      return {
        ok: false,
        reason: 'per_ip_budget_exhausted',
        message: '本机今日兜底 Key 额度已用尽，请配置自己的 API Key',
      };
    }
    if (this.cfg.trialEnabled && this.cfg.trialDailyLimit > 0 && ipRuns >= this.cfg.trialDailyLimit) {
      return {
        ok: false,
        reason: 'trial_exhausted',
        message: `今日试用次数已用完（${this.cfg.trialDailyLimit} 次/天），请配置自己的 API Key`,
      };
    }
    return { ok: true };
  }

  /**
   * 运行前质检并预占一次运行额度（成功/失败都算一次，防无限重试薅额度）。
   * 仅当所有预算/试用闸通过时返回 ok=true；否则返回可展示的拒绝原因。
   */
  reserve(clientIp: string, now = Date.now()): ReserveResult {
    const check = this.checkOnly(clientIp, now);
    if (!check.ok) return check;
    this.add('ip', clientIp || 'unknown', this.dayStart(now), 0, 1);
    return { ok: true };
  }

  /** 任务结束后记账真实 token 用量（全局 + 每 IP）。 */
  recordUsage(clientIp: string, tokens: number, now = Date.now()): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const period = this.dayStart(now);
    const n = Math.floor(tokens);
    this.add('global', GLOBAL_KEY, period, n, 0);
    this.add('ip', clientIp || 'unknown', period, n, 0);
  }

  /** 无副作用的当前状态（供 GET /agent/trial-status 与客户端横幅）。 */
  describe(clientIp: string, now = Date.now()): TrialStatus {
    const period = this.dayStart(now);
    const ip = clientIp || 'unknown';
    const ipRow = this.read('ip', ip, period);
    const usedRuns = ipRow?.runs ?? 0;
    const dailyLimit =
      this.cfg.trialEnabled && this.cfg.trialDailyLimit > 0 ? this.cfg.trialDailyLimit : null;
    const remainingRuns = dailyLimit === null ? null : Math.max(0, dailyLimit - usedRuns);
    const denied = this.checkOnly(clientIp, now);
    return {
      enabled: this.cfg.trialEnabled && this.cfg.serverKeyConfigured,
      trialModeEnabled: this.cfg.trialEnabled,
      serverKeyConfigured: this.cfg.serverKeyConfigured,
      dailyLimit,
      usedRuns,
      remainingRuns,
      perTaskTokenLimit: this.cfg.perTaskTokenLimit,
      budgetExceeded: !denied.ok,
      budgetReason: denied.reason ?? null,
    };
  }
}