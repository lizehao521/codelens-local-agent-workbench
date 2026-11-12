import { describe, it, expect } from 'vitest';
import { computeRateWait } from '../src/providers/rate-limit.ts';

const WINDOW = 60_000;

describe('computeRateWait（出网 LLM 限速，每分钟 N 次）', () => {
  it('窗口未满时立即放行', () => {
    const now = 1_000_000;
    expect(computeRateWait([now - 10_000, now - 5_000, now - 1_000], now, 5, WINDOW)).toBe(-1);
  });

  it('刚满窗口时计算到下一条滑出的等待', () => {
    const now = 1_000_000;
    const ts = [now - 30_000, now - 20_000, now - 10_000, now - 5_000, now - 1_000];
    const wait = computeRateWait(ts, now, 5, WINDOW);
    expect(wait).toBeGreaterThanOrEqual(30_000);
    expect(wait).toBeLessThanOrEqual(30_000 + 25);
  });

  it('过滤掉窗口外的旧时间戳', () => {
    const now = 1_000_000;
    const ts = [now - 90_000, now - 80_000, now - 70_000, now - 65_000, now - 61_000, now - 1_000];
    expect(computeRateWait(ts, now, 5, WINDOW)).toBe(-1);
  });

  it('limit=1 时紧跟的请求必须等到窗口边界', () => {
    const now = 1_000_000;
    const wait = computeRateWait([now - 500], now, 1, WINDOW);
    expect(wait).toBeGreaterThanOrEqual(59_500);
  });

  it('空数组立即放行', () => {
    expect(computeRateWait([], 1_000_000, 5, WINDOW)).toBe(-1);
  });
});
