// ToolCallCard —— 工具调用卡（AC-03）：类别图标 + 规范名 + 七态 + 耗时 + 参数/结果摘要
// 折叠纪律：成功默认折叠、失败默认展开、skipped/rejected 可展开且不计失败数；
// 高频事件只改 byId[callId] 单卡引用，本组件经 useToolCall(callId) 精确订阅。

import { useMemo, useState } from 'react';
import {
  Ban,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  Loader,
  RotateCw,
  SkipForward,
  TriangleAlert,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ToolCallStatus, ToolCallVM } from '../../types';
import { useToolCall, useToolCallStore } from '../../stores/toolCallStore';
import { categoryIcon } from '../../lib/tool-category';
import { buildErrorBlock, configForKind, semanticBadge, semanticText } from '../../lib/error-kind';
import { formatCount, formatDuration, formatRelativeOffset } from '../../lib/tool-format';
import { inlinePreview, isTruncated, omittedChars } from '../../lib/tool-preview';
import { cn } from '../../lib/cn';
import { ToolCallDiff } from './ToolCallDiff';

const STATUS_META: Record<ToolCallStatus, { label: string; icon: LucideIcon; className: string }> = {
  pending: { label: '等待确认', icon: Clock, className: 'text-warning' },
  running: { label: '执行中', icon: Loader, className: 'text-accent' },
  success: { label: '成功', icon: CircleCheck, className: 'text-success' },
  failed: { label: '失败', icon: CircleX, className: 'text-danger' },
  timeout: { label: '超时', icon: Clock, className: 'text-warning' },
  rejected: { label: '已拒绝', icon: Ban, className: 'text-text-secondary' },
  skipped: { label: '已跳过', icon: CircleSlash, className: 'text-text-secondary' },
};

/** 参数摘要：取前两个键的值，超长截断（服务端已存 args_json，这里只做展示层压缩） */
function summarizeArguments(args: Record<string, unknown> | string): string {
  if (typeof args === 'string') return args.slice(0, 80) || '（无参数）';
  const entries = Object.entries(args);
  if (entries.length === 0) return '（无参数）';
  return entries
    .slice(0, 2)
    .map(([key, value]) => {
      const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
      const clipped = raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
      return `${key}=${clipped}`;
    })
    .join('，')
    + (entries.length > 2 ? ` 等 ${entries.length} 项` : '');
}

export interface ToolCallCardProps {
  callId: string;
  /** 所属消息创建时间（相对偏移基准） */
  baseAt?: number;
  /** AC-10：单步重试（callId 重发，服务端 resumeFromCallId，不带参数覆写） */
  onRetryStep?: (callId: string) => void;
  /** AC-10：从某步重跑（callId + 该步原参数作为 overrideArguments） */
  onRerunFrom?: (callId: string, overrideArguments?: Record<string, unknown>) => void;
  /** 审批条插槽（pending 时由父级渲染 ToolApprovalBar） */
  approvalSlot?: React.ReactNode;
  /** 重试计数变化时禁用的外部条件（流式中） */
  disabled?: boolean;
}

export function ToolCallCard({ callId, baseAt, onRetryStep, onRerunFrom, approvalSlot, disabled }: ToolCallCardProps) {
  const call = useToolCall(callId);
  const markRetry = useToolCallStore((s) => s.markRetry);
  const [expanded, setExpanded] = useState<boolean | null>(null);

  // 展开态：undefined = 按状态默认（失败展开 / 成功折叠）；用户点过以后尊重用户
  const defaultExpanded = useMemo(() => {
    if (!call) return false;
    return call.status === 'failed' || call.status === 'timeout';
  }, [call?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const isExpanded = expanded ?? defaultExpanded;

  if (!call) return null;

  const statusMeta = STATUS_META[call.status];
  const StatusIcon = statusMeta.icon;
  const Icon = categoryIcon(call.category, call.name);
  const isPending = call.status === 'pending';
  // AC-10「从某步重跑」需把该步原参数作为 overrideArguments 传给服务端；
  // 旧数据可能把 arguments 存成字符串（展示层兼容），此时不覆写、仅 resumeFromCallId。
  const rerunArgs: Record<string, unknown> | undefined =
    typeof call.arguments === 'string' ? undefined : call.arguments;
  const diffs = call.diff ?? call.effect?.diff ?? [];
  const canRetry =
    !disabled &&
    (call.status === 'failed' || call.status === 'timeout') &&
    call.retryCount < 3 &&
    !configForKind(call.error?.kind).securityBlocked;

  const handleRetry = (): void => {
    if (!canRetry) return;
    markRetry(callId);
    onRetryStep?.(callId);
  };

  return (
    <div
      className={cn(
        'rounded-md border bg-bg-tertiary transition-colors duration-150',
        call.status === 'failed' || call.status === 'timeout' ? 'border-border' : 'border-border-subtle',
      )}
    >
      {/* 头部：图标 + 规范名 + 状态 + 耗时 */}
      <button
        type="button"
        onClick={() => setExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
        aria-expanded={isExpanded}
      >
        <Icon size={14} className="shrink-0 text-text-secondary" />
        <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
          {call.displayName ?? call.name}
          <span className="ml-1.5 font-mono text-xs text-text-tertiary">{call.name}</span>
        </span>
        {call.source === 'mcp' && (
          <span className="shrink-0 rounded bg-bg-inset px-1.5 py-0.5 text-xs text-text-tertiary">MCP</span>
        )}
        <span className={cn('flex shrink-0 items-center gap-1 text-xs', statusMeta.className)}>
          <StatusIcon size={12} className={call.status === 'running' ? 'animate-spin' : undefined} />
          {statusMeta.label}
        </span>
        <span className="shrink-0 font-mono text-xs text-text-tertiary">
          {formatDuration(call.durationMs)}
        </span>
        {isExpanded ? (
          <ChevronDown size={14} className="shrink-0 text-text-tertiary" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-text-tertiary" />
        )}
      </button>

      {/* 摘要行（折叠态也可见） */}
      <div className="border-t border-border-subtle px-2.5 py-1.5">
        <p className="truncate font-mono text-xs text-text-secondary" title={summarizeArguments(call.arguments)}>
          {summarizeArguments(call.arguments)}
        </p>
        {call.status !== 'pending' && call.summary && (
          <p className="mt-0.5 truncate text-xs text-text-tertiary" title={call.summary}>
            {call.summary}
          </p>
        )}
        {call.status === 'running' && call.progress && (
          <p className="mt-0.5 truncate text-xs text-accent">{call.progress}</p>
        )}
        {call.status === 'skipped' && (
          <p className="mt-0.5 text-xs text-text-tertiary">
            <SkipForward size={10} className="mr-1 inline" />
            参数修订后，此步及其后续调用不再执行（不计入失败数）
          </p>
        )}
        {call.status === 'rejected' && (
          <p className="mt-0.5 text-xs text-text-tertiary">用户拒绝了这次调用，未执行</p>
        )}
      </div>

      {/* 展开区：参数 + 结果 + 错误 */}
      {isExpanded && (
        <div className="border-t border-border-subtle px-2.5 py-2">
          <Section title="参数">
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-text-secondary">
              {typeof call.arguments === 'string'
                ? call.arguments
                : JSON.stringify(call.arguments, null, 2)}
            </pre>
          </Section>

          {call.resultText && (
            <Section title="结果">
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-text-secondary">
                {isTruncated(call.resultText) ? inlinePreview(call.resultText) : call.resultText}
              </pre>
              <div className="mt-1 flex items-center gap-2 text-xs text-text-tertiary">
                {typeof call.bytes === 'number' && <span>{formatCount(call.bytes)} 字节</span>}
                {call.truncated && <span className="text-warning">已截断</span>}
                {call.artifactPath && <span className="font-mono">已落盘</span>}
                {isTruncated(call.resultText) && <span>省略 {formatCount(omittedChars(call.resultText, inlinePreview(call.resultText)))} 字符</span>}
              </div>
            </Section>
          )}

          {call.error && <ErrorBlock call={call} />}

          {/* R6：可逆调用的执行后独立复核（只展示事实指摘与真实成本） */}
          {(call.reviewPending || call.review) && (
            <Section title="独立复核">
              {call.reviewPending && !call.review ? (
                <p className="text-xs text-text-tertiary">已执行，复核结论并行回填中…</p>
              ) : call.review ? (
                <div className="space-y-1">
                  <div
                    className={cn(
                      'text-xs',
                      call.review.status === 'underestimated'
                        ? 'text-danger'
                        : call.review.status === 'unexec'
                          ? 'text-text-tertiary'
                          : 'text-success',
                    )}
                  >
                    {call.review.status === 'underestimated'
                      ? '复核认为影响面被低估：'
                      : call.review.status === 'unexec'
                        ? `复核未执行：${call.review.reason ?? '未配置复核模型'}`
                        : '复核未发现不可逆项被低估'}
                  </div>
                  {call.review.findings.map((finding, index) => (
                    <div key={`${finding.factRef ?? index}`} className="flex items-start gap-1 text-xs text-text-secondary">
                      <TriangleAlert size={10} className="mt-0.5 shrink-0 text-warning" />
                      <span className="min-w-0 flex-1 break-all">
                        [{finding.severity}] {finding.claim}
                      </span>
                    </div>
                  ))}
                  <div className="text-[11px] text-text-tertiary">
                    {call.review.model} · {call.review.latencyMs}ms ·{' '}
                    {call.review.usage.promptTokens + call.review.usage.completionTokens} tokens
                  </div>
                </div>
              ) : null}
            </Section>
          )}

          {diffs.length > 0 && <ToolCallDiff items={diffs} />}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {canRetry && (
              <CardAction icon={RotateCw} label="重试" onClick={handleRetry} />
            )}
            {onRerunFrom && call.status !== 'pending' && (
              <CardAction
                icon={SkipForward}
                label="从这步重跑"
                onClick={() => onRerunFrom(callId, rerunArgs)}
                disabled={disabled}
              />
            )}
            {baseAt !== undefined && call.startedAt !== undefined && (
              <span className="ml-auto font-mono text-xs text-text-tertiary">
                {formatRelativeOffset(call.startedAt, baseAt)}
              </span>
            )}
          </div>
        </div>
      )}
      {isPending && approvalSlot && <div className="border-t border-border-subtle p-2">{approvalSlot}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 last:mb-0">
      <p className="mb-1 text-xs font-medium text-text-tertiary">{title}</p>
      {children}
    </div>
  );
}

/** 错误区：第 1–5 层（label/message/context/suggestion/actions），规则全在 lib/error-kind */
function ErrorBlock({ call }: { call: ToolCallVM }) {
  const error = call.error!;
  const block = buildErrorBlock(error, call.name);
  return (
    <div className={cn('mb-2 rounded border border-border-subtle p-2', block.semantic === 'neutral' ? 'bg-bg-inset' : 'bg-bg-primary')}>
      <div className="flex items-center gap-1.5">
        <TriangleAlert size={12} className={semanticText(block.semantic)} />
        <span className={cn('rounded px-1.5 py-0.5 text-xs', semanticBadge(block.semantic))}>{block.label}</span>
        <span className="font-mono text-xs text-text-tertiary">{block.code}</span>
      </div>
      <p className="mt-1 text-xs text-text-primary">{block.message}</p>
      {block.context && <p className="mt-0.5 text-xs text-text-secondary">{block.context}</p>}
      {block.suggestion && <p className="mt-0.5 text-xs text-text-tertiary">建议：{block.suggestion}</p>}
      {block.securityBlocked && (
        <p className="mt-1 text-xs text-text-tertiary">安全策略拦截不会自动重试，同一目标本任务内不再尝试。</p>
      )}
    </div>
  );
}

function CardAction({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs text-text-secondary',
        'transition-colors duration-150 hover:border-accent hover:text-accent',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-text-secondary',
      )}
    >
      <Icon size={11} />
      {label}
    </button>
  );
}
