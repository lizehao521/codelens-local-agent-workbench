import { describe, it, expect } from 'vitest';
import { createDb } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { FallbackBudgetService, type FallbackBudgetConfig } from '../src/services/agent/fallback-budget.service.js';

const DAY_MS = 86_400_000;
const NOW = 1_760_000_000_000; // 固定时间戳，保证跨日测试确定性

function makeService(overrides: Partial<FallbackBudgetConfig> = {}) {
  const db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  const svc = new FallbackBudgetService(db, {
    trialEnabled: false,
    trialDailyLimit: 5,
    globalDailyTokenLimit: 0,
    perIpDailyTokenLimit: 0,
    perTaskTokenLimit: 0,
    serverKeyConfigured: true,
    ...overrides,
  });
  return { db, svc };
}

describe('FallbackBudgetService（A-01/A-02）', () => {
  it('试用关闭且无 token 闸时始终放行，enabled=false', () => {
    const { svc } = makeService({ trialEnabled: false });
    expect(svc.reserve('1.2.3.4', NOW).ok).toBe(true);
    expect(svc.reserve('1.2.3.4', NOW).ok).toBe(true);
    expect(svc.describe('1.2.3.4', NOW).enabled).toBe(false);
  });

  it('试用（A-02）：每 IP 每日 N 次，超限拒绝且不影响其他 IP', () => {
    const { svc } = makeService({ trialEnabled: true, trialDailyLimit: 2 });
    expect(svc.reserve('10.0.0.1', NOW).ok).toBe(true);
    expect(svc.reserve('10.0.0.1', NOW).ok).toBe(true);
    const third = svc.reserve('10.0.0.1', NOW);
    expect(third.ok).toBe(false);
    expect(third.reason).toBe('trial_exhausted');
    expect(svc.reserve('10.0.0.2', NOW).ok).toBe(true);
  });

  it('每 IP 日 token 预算（A-01）：记账后超限即拒绝', () => {
    const { svc } = makeService({ trialEnabled: true, perIpDailyTokenLimit: 100 });
    svc.reserve('10.0.0.1', NOW);
    svc.recordUsage('10.0.0.1', 100, NOW);
    const res = svc.reserve('10.0.0.1', NOW);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('per_ip_budget_exhausted');
    expect(svc.reserve('10.0.0.2', NOW).ok).toBe(true);
  });

  it('全局日 token 预算（A-01）：任一 IP 记账超限后全员拒绝', () => {
    const { svc } = makeService({ globalDailyTokenLimit: 50 });
    svc.recordUsage('10.0.0.1', 50, NOW);
    const res = svc.reserve('10.0.0.2', NOW);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('global_budget_exhausted');
  });

  it('跨日归零：昨日用量不计入今日', () => {
    const { svc } = makeService({ trialEnabled: true, trialDailyLimit: 1, perIpDailyTokenLimit: 10 });
    const yesterday = NOW - DAY_MS;
    svc.reserve('10.0.0.1', yesterday);
    svc.recordUsage('10.0.0.1', 10, yesterday);
    const today = svc.describe('10.0.0.1', NOW);
    expect(today.usedRuns).toBe(0);
    expect(svc.reserve('10.0.0.1', NOW).ok).toBe(true);
  });

  it('describe 反映剩余次数与 budgetExceeded', () => {
    const { svc } = makeService({ trialEnabled: true, trialDailyLimit: 3 });
    svc.reserve('10.0.0.1', NOW);
    const d = svc.describe('10.0.0.1', NOW);
    expect(d.enabled).toBe(true);
    expect(d.usedRuns).toBe(1);
    expect(d.remainingRuns).toBe(2);
    expect(d.budgetExceeded).toBe(false);
  });

  it('未配置兜底 Key 时试用不可用（enabled=false）', () => {
    const { svc } = makeService({ trialEnabled: true, serverKeyConfigured: false });
    const d = svc.describe('10.0.0.1', NOW);
    expect(d.enabled).toBe(false);
    expect(d.trialModeEnabled).toBe(true);
    expect(d.serverKeyConfigured).toBe(false);
  });

  it('perTaskTokenLimit 透传（供 loop 覆盖单任务预算）', () => {
    const { svc } = makeService({ perTaskTokenLimit: 4096 });
    expect(svc.perTaskTokenLimit).toBe(4096);
  });

  it('recordUsage 对非法/非正值幂等无害', () => {
    const { svc } = makeService({});
    expect(() => svc.recordUsage('10.0.0.1', NaN, NOW)).not.toThrow();
    expect(() => svc.recordUsage('10.0.0.1', 0, NOW)).not.toThrow();
    expect(() => svc.recordUsage('10.0.0.1', -5, NOW)).not.toThrow();
    expect(svc.describe('10.0.0.1', NOW).budgetExceeded).toBe(false);
  });
});