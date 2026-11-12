// RunStageBanner —— R3：运行阶段与等待计时（连接上游 / 已响应 / 生成中 / 终局）
// 设计取舍：只做文字 + 脉冲点，不做假进度条；计时每秒本地更新，10s 未拿到上游响应升级提示。

import { useEffect, useState } from 'react';
import { LoaderCircle, Square, Timer, WifiOff } from 'lucide-react';
import { useRunStore } from '../../stores/runStore';
import type { AgentStagePayload } from '../../types';
import { cn } from '../../lib/cn';

const SLOW_UPSTREAM_SECONDS = 10;

type Stage = AgentStagePayload['stage'];

/** 阶段文案：给用户「现在卡在哪一步」，而不是一个笼统的加载态。 */
const STAGE_LABEL: Record<Stage, string> = {
  connecting: '正在连接模型…',
  upstream_first_byte: '模型已响应，正在生成…',
  reasoning: '模型正在思考…',
  content: '正在输出…',
  done: '已完成',
  upstream_error: '上游出错',
  upstream_timeout: '上游响应超时',
  aborted: '已中止',
};

/** 这些阶段仍属于「等上游」，超过阈值才提示慢。 */
const WAITING_STAGES: Stage[] = ['connecting', 'upstream_first_byte'];

export function RunStageBanner({ onAbort }: { onAbort: () => void }) {
  const streaming = useRunStore((s) => s.streaming);
  const stage = useRunStore((s) => s.stage);
  const acceptedAt = useRunStore((s) => s.acceptedAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!streaming) return;
    // 每次新 run 开始（acceptedAt 变化）先把计时基准对齐，避免沿用上一次挂载时的 now。
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [streaming, acceptedAt]);

  if (!streaming) return null;

  const current: Stage = stage?.stage ?? 'connecting';
  const elapsedSec = acceptedAt ? Math.max(0, Math.floor((now - acceptedAt) / 1000)) : 0;
  const slow = elapsedSec >= SLOW_UPSTREAM_SECONDS && WAITING_STAGES.includes(current);
  const failed = current === 'upstream_error' || current === 'upstream_timeout';

  return (
    <div
      className="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-bg-tertiary px-3 py-1.5"
      data-testid="run-stage-banner"
      data-stage={current}
    >
      {failed ? (
        <WifiOff size={12} className="shrink-0 text-danger" aria-hidden="true" />
      ) : (
        <LoaderCircle size={12} className="shrink-0 animate-spin text-accent" aria-hidden="true" />
      )}

      <span
        role="status"
        aria-live="polite"
        className={cn('min-w-0 truncate text-xs', failed ? 'text-danger' : 'text-text-secondary')}
      >
        {slow ? `上游响应较慢（${STAGE_LABEL[current]}）` : STAGE_LABEL[current]}
      </span>

      <span
        className="inline-flex items-center gap-1 text-xs tabular-nums text-text-tertiary"
        aria-hidden="true"
      >
        <Timer size={11} />
        已等待 {elapsedSec}s
      </span>

      {slow && !failed && (
        <span className="text-xs text-text-tertiary">可继续等待，或中止后重试</span>
      )}

      <button
        type="button"
        onClick={onAbort}
        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-text-secondary transition-colors duration-150 hover:border-danger hover:text-danger"
      >
        <Square size={10} aria-hidden="true" />
        中止
      </button>
    </div>
  );
}
