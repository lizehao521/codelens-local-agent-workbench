// ContextOccupancyBar —— 上下文占用条（AC-11）：顶部常驻，>75% 琥珀、>88% 警示
// 数据源：runStore.meta（服务端估算）；无 meta 时按本地消息 token 兜底估算。

import { useMemo } from 'react';
import { useRunStore } from '../../stores/runStore';
import { useServerSessionStore } from '../../stores/serverSessionStore';
import { fmtTokens, usagePercent } from '../../lib/tool-format';
import { cn } from '../../lib/cn';

const AMBER_THRESHOLD = 75;
const RED_THRESHOLD = 88;

export function ContextOccupancyBar() {
  const meta = useRunStore((s) => s.meta);
  const messages = useServerSessionStore((s) => s.messages);

  // 本地兜底：meta 未到（首轮前）时用消息 token 之和
  const localTokens = useMemo(
    () => messages.reduce((acc, m) => acc + (m.tokens ?? 0), 0),
    [messages],
  );

  const used = meta?.estimatedPromptTokens ?? localTokens;
  const window = meta?.contextWindow;
  const percent = usagePercent(used, window);

  const tone = percent >= RED_THRESHOLD ? 'danger' : percent >= AMBER_THRESHOLD ? 'warning' : 'normal';
  const barClass =
    tone === 'danger' ? 'bg-danger' : tone === 'warning' ? 'bg-warning' : 'bg-accent';
  const textClass =
    tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-text-tertiary';

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1">
      <span className="shrink-0 text-xs text-text-tertiary">上下文</span>
      <div
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-inset"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="上下文占用"
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-250', barClass)}
          style={{ width: `${Math.max(percent, used > 0 ? 2 : 0)}%` }}
        />
      </div>
      <span className={cn('shrink-0 font-mono text-xs', textClass)}>
        {fmtTokens(used)}
        {window ? ` / ${fmtTokens(window)}` : ''}（{percent}%）
      </span>
      {tone !== 'normal' && (
        <span className={cn('shrink-0 text-xs', textClass)}>
          {tone === 'danger' ? '接近上限，将触发压缩' : '占用偏高'}
        </span>
      )}
    </div>
  );
}
