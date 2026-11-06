// 工具卡展示层格式化 —— 耗时 / 相对偏移 / token / 倒计时
// 全部纯函数，不依赖 React，可在 vitest 直接测试。

/** 耗时：<1000ms → 38ms；<60s → 1.2s；≥60s → 1m 12s；未结束 → — */
export function formatDuration(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * 相对时间戳：+1.2s = (call.startedAt - message.createdAt) / 1000，1 位小数。
 * 未开始（无 startedAt）→ —
 */
export function formatRelativeOffset(startedAt: number | undefined, baseAt: number): string {
  if (typeof startedAt !== 'number') return '—';
  const diff = startedAt - baseAt;
  if (!Number.isFinite(diff)) return '—';
  return `+${(diff / 1000).toFixed(1)}s`;
}

/** 令牌剩余倒计时：>60s → 4:32；≤60s → 0:42 */
export function formatCountdown(remainMs: number): string {
  if (!Number.isFinite(remainMs) || remainMs <= 0) return '0:00';
  const total = Math.ceil(remainMs / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 相邻两次调用之间的间隔：>1000ms 才显示 */
export function formatGap(nextStartedAt: number | undefined, prevEndedAt: number | undefined): string | null {
  if (typeof nextStartedAt !== 'number' || typeof prevEndedAt !== 'number') return null;
  const gap = nextStartedAt - prevEndedAt;
  if (!Number.isFinite(gap) || gap <= 1000) return null;
  return `间隔 ${(gap / 1000).toFixed(1)}s`;
}

/** token 数格式化：999 / 1.2k（沿用既有 lib/format 口径，此处独立导出便于测试） */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.floor(n));
  return `${(n / 1000).toFixed(1)}k`;
}

/** 上下文占用百分比（0–100，向上取整，避免 0% 却有 token） */
export function usagePercent(used: number | undefined, window: number | undefined): number {
  if (typeof used !== 'number' || typeof window !== 'number' || window <= 0) return 0;
  const raw = (used / window) * 100;
  if (raw <= 0) return 0;
  return Math.min(100, Math.max(1, Math.round(raw)));
}

/** 千分位整数（结果字符数 / 字节数展示） */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  return Math.round(n).toLocaleString('en-US');
}
