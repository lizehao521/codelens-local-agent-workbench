/**
 * RunState 汇报卡（R6）。
 *
 * 设计口径：默认「有实质变化才出」——纯问答 / 只读极简不打扰；
 * 服务端只在 hasMaterialChange 时下发（或 RUN_REPORT_EVERY=1 时每轮必报）。
 * 卡片只展示 RunState 里的结构化数字，不重新拼装剧情。
 */

import { Activity, FilePen, ShieldCheck, Wallet } from 'lucide-react';
import { useRunStore } from '../../stores/runStore';
import { cn } from '../../lib/cn';
import type { RunOutcome } from '../../types';

/** A-3：完成 / 预算耗尽 / 收敛 / 中止 / 出错必须使用不同文案与颜色。 */
const OUTCOME_COPY: Record<RunOutcome, { label: string; tone: string }> = {
  completed: { label: '已完成', tone: 'text-success' },
  budget_exhausted: { label: '预算耗尽 · 未完成', tone: 'text-warning' },
  converged: { label: '收敛停止 · 未完成', tone: 'text-accent' },
  aborted: { label: '已中止', tone: 'text-text-secondary' },
  error: { label: '出错', tone: 'text-danger' },
};

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function RunReportCard() {
  const report = useRunStore((s) => s.report);
  if (!report) return null;

  const totalTokens = report.promptTokens + report.completionTokens;
  const reviewTokens = report.reviewPromptTokens + report.reviewCompletionTokens;
  const outcome = OUTCOME_COPY[report.outcome] ?? OUTCOME_COPY.error;

  return (
    <div
      className="mx-3 mt-2 shrink-0 rounded-lg border border-border bg-bg-inset px-3 py-2"
      role="status"
      aria-live="polite"
      data-outcome={report.outcome}
      data-status-code={report.statusCode}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
        <Activity size={12} className="text-accent" />
        本轮汇报
        <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-semibold', outcome.tone, 'bg-bg-primary')}>
          {outcome.label}
        </span>
        <span className="font-mono text-[11px] text-text-tertiary">{report.statusCode}</span>
        <span className="ml-auto font-mono text-[11px] text-text-tertiary">{report.runId}</span>
      </div>
      <p className="mt-1 text-xs text-text-secondary">{report.summary}</p>
      {report.reason && (
        <p className="mt-1 rounded bg-bg-primary px-2 py-1 text-[11px] text-text-secondary">
          {report.reason}
        </p>
      )}
      {report.notDone.length > 0 && (
        <div className="mt-1 text-[11px] text-text-tertiary">
          未完成：
          <ul className="ml-4 list-disc">
            {report.notDone.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
        {report.triggers.map((trigger) => (
          <span
            key={trigger}
            className={cn(
              'rounded px-1.5 py-0.5',
              trigger === '不可逆操作' ? 'bg-danger-subtle text-danger' : 'bg-bg-primary text-text-secondary',
            )}
          >
            {trigger}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-3 text-text-tertiary">
          {report.fileChangeCount > 0 && (
            <span className="flex items-center gap-1">
              <FilePen size={10} />
              {report.fileChangeCount}
            </span>
          )}
          {report.approvalCount > 0 && (
            <span className="flex items-center gap-1">
              <ShieldCheck size={10} />
              {report.approvalCount}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Wallet size={10} />
            {fmt(totalTokens)} tokens
            {reviewTokens > 0 && <span className="text-text-tertiary">（复核 {fmt(reviewTokens)}）</span>}
          </span>
        </span>
      </div>
    </div>
  );
}
