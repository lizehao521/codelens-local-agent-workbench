// AgentMessageItem —— 单条消息的 segments 渲染（C-6）：text / tool / notice 三段式
// tool 段只存 callId：卡内状态由 toolCallStore 单卡订阅驱动，文本段不随工具事件重渲染。

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Info, Sparkles, User } from 'lucide-react';
import type { ContextNotice, SessionMessageRow, Segment } from '../../types';
import { useApprovalStore } from '../../stores/approvalStore';
import { useToolCallStore } from '../../stores/toolCallStore';
import { useRunStore } from '../../stores/runStore';
import { buildToolBlocks, countFailures } from '../../lib/tool-grouping';
import { ToolCallCard } from './ToolCallCard';
import { ToolApprovalBar } from './ToolApprovalBar';
import { MarkdownContent } from '../result/MarkdownContent';
import { cn } from '../../lib/cn';

export interface AgentMessageItemProps {
  message: SessionMessageRow;
  /** AC-10：单步重试 */
  onRetryStep?: (callId: string) => void;
  /** AC-10：从某步重跑 */
  onRerunFrom?: (callId: string, overrideArguments?: Record<string, unknown>) => void;
  busy?: boolean;
}

export function AgentMessageItem({ message, onRetryStep, onRerunFrom, busy }: AgentMessageItemProps) {
  const isUser = message.role === 'user';
  const segments = message.segments ?? [];

  // 用户消息：segments 为空时回落纯文本（老数据 / 服务端 detail 的 content 字段）
  const effective: Segment[] = useMemo(() => {
    if (segments.length > 0) return segments;
    if (message.content) return [{ type: 'text', text: message.content }];
    return [];
  }, [segments, message.content]);

  return (
    <div className="flex gap-2 px-3 py-2">
      <div
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
          isUser ? 'bg-bg-inset' : 'bg-accent-subtle',
        )}
      >
        {isUser ? (
          <User size={13} className="text-text-secondary" />
        ) : (
          <Sparkles size={13} className="text-accent" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {isUser ? (
          <p className="whitespace-pre-wrap break-words text-sm text-text-primary">{message.content}</p>
        ) : (
          <AssistantSegments
            message={message}
            segments={effective}
            onRetryStep={onRetryStep}
            onRerunFrom={onRerunFrom}
            busy={busy}
          />
        )}
      </div>
    </div>
  );
}

function AssistantSegments({
  message,
  segments,
  onRetryStep,
  onRerunFrom,
  busy,
}: {
  message: SessionMessageRow;
  segments: Segment[];
  onRetryStep?: (callId: string) => void;
  onRerunFrom?: (callId: string, overrideArguments?: Record<string, unknown>) => void;
  busy?: boolean;
}) {
  // 流式中标记（本地态；reconcile 后由服务端数据覆盖）
  const streaming = message.status === 'streaming';

  // 汇总行口径：>8 次调用的轮次折叠（tool-grouping 规则）
  const callIds = useMemo(
    () => segments.filter((s): s is Extract<Segment, { type: 'tool' }> => s.type === 'tool').map((s) => s.callId),
    [segments],
  );
  // zustand v5 默认用 Object.is 比较选择器返回值：若直接 map 出新数组，每次渲染引用都不同，
  // 会触发无限重渲染（白屏）。改为选择稳定的 byId 引用，再在 useMemo 中派生 calls。
  const byId = useToolCallStore((s) => s.byId);
  const calls = useMemo(
    () => callIds.map((id) => byId[id]).filter((c): c is NonNullable<typeof c> => !!c),
    [callIds, byId],
  );
  const failures = countFailures(calls);

  // 把 segments 按「连续 tool 段」分组，组内走 buildToolBlocks（同名合并）
  const groups = useMemo(() => groupSegments(segments), [segments]);

  // 首 token 之前的空窗：推理模型实测可达十几秒，没有任何中间态时界面看起来像卡死。
  const hasAnswerText = groups.some((g) => g.kind === 'text' && g.text.trim());
  const waiting = streaming && !message.reasoningText && groups.length === 0;
  // 失败/中止且一个字都没产出：不留一个只有头像的空白气泡，改为明确状态提示。
  const failedEmpty =
    !streaming &&
    groups.length === 0 &&
    !message.reasoningText &&
    (message.status === 'error' || message.status === 'aborted');
  // 正文开始输出后，推理块不再算「思考中」，折叠收起把版面让给答案。
  const reasoningActive = streaming && !hasAnswerText;

  return (
    <div className="space-y-1.5">
      {message.reasoningText && (
        <ReasoningBlock text={message.reasoningText} streaming={reasoningActive} />
      )}
      {waiting && <WaitingHint />}
      {groups.map((group, gi) => {
        if (group.kind === 'text') {
          if (!group.text.trim()) return null;
          return (
            <MarkdownContent key={`t${gi}`} content={group.text} />
          );
        }
        if (group.kind === 'notice') {
          return <ContextNoticeChip key={`n${gi}`} notice={group.notice} />;
        }
        const groupCalls = group.callIds
          .map((id) => calls.find((c) => c.callId === id))
          .filter((c): c is NonNullable<typeof c> => !!c);
        const groupBlocks = buildToolBlocks(groupCalls);
        const groupFailures = countFailures(groupCalls);
        return (
          <div key={`g${gi}`} className="space-y-1">
            {groupCalls.length > 8 && (
              <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
                <span>本轮 {groupCalls.length} 次调用</span>
                {groupFailures > 0 && <span className="text-danger">{groupFailures} 次失败</span>}
                <span>（同名连续已合并）</span>
              </div>
            )}
            {groupBlocks.map((block, bi) =>
              block.kind === 'single' ? (
                <ToolCard
                  key={block.call.callId}
                  callId={block.call.callId}
                  baseAt={message.createdAt}
                  onRetryStep={onRetryStep}
                  onRerunFrom={onRerunFrom}
                  busy={busy}
                />
              ) : (
                <ToolGroupBlock
                  key={`${block.toolName}-${bi}`}
                  callIds={block.calls.map((c) => c.callId)}
                  baseAt={message.createdAt}
                  onRetryStep={onRetryStep}
                  onRerunFrom={onRerunFrom}
                  busy={busy}
                />
              ),
            )}
          </div>
        );
      })}

      {failures > 0 && (
        <p className="text-xs text-text-tertiary">
          {failures} 次调用未成功（被拒绝 / 跳过的调用不计入）
        </p>
      )}
      {failedEmpty && (
        <p className="text-xs text-text-tertiary">
          {message.status === 'aborted' ? '已中止，本轮未生成回复。' : '本轮未生成回复，请根据错误提示重试。'}
        </p>
      )}
      {streaming && <StreamingCursor />}
    </div>
  );
}

function ToolCard({
  callId,
  baseAt,
  onRetryStep,
  onRerunFrom,
  busy,
}: {
  callId: string;
  baseAt: number;
  onRetryStep?: (callId: string) => void;
  onRerunFrom?: (callId: string, overrideArguments?: Record<string, unknown>) => void;
  busy?: boolean;
}) {
  const approval = useApprovalStore((s) => s.byCallId[callId]);
  return (
    <ToolCallCard
      callId={callId}
      baseAt={baseAt}
      onRetryStep={onRetryStep}
      onRerunFrom={onRerunFrom}
      disabled={busy}
      approvalSlot={
        approval ? <ToolApprovalBar approval={approval} /> : undefined
      }
    />
  );
}

/** 同名连续 ≥3 次合并为组（AC-03 时间线可读性） */
function ToolGroupBlock({
  callIds,
  baseAt,
  onRetryStep,
  onRerunFrom,
  busy,
}: {
  callIds: string[];
  baseAt: number;
  onRetryStep?: (callId: string) => void;
  onRerunFrom?: (callId: string, overrideArguments?: Record<string, unknown>) => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-md border border-border-subtle bg-bg-tertiary">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-text-secondary"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        连续 {callIds.length} 次同名调用
      </button>
      {open && (
        <div className="space-y-1 border-t border-border-subtle p-1.5">
          {callIds.map((id) => (
            <ToolCard
              key={id}
              callId={id}
              baseAt={baseAt}
              onRetryStep={onRetryStep}
              onRerunFrom={onRerunFrom}
              busy={busy}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type RenderGroup =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; callIds: string[] }
  | { kind: 'notice'; notice: ContextNotice };

/** 把 segments 折叠为渲染组：连续 tool 段合并（供分组与汇总行使用） */
function groupSegments(segments: Segment[]): RenderGroup[] {
  const out: RenderGroup[] = [];
  for (const seg of segments) {
    if (seg.type === 'text') {
      const last = out[out.length - 1];
      if (last && last.kind === 'text') last.text += seg.text;
      else out.push({ kind: 'text', text: seg.text });
    } else if (seg.type === 'tool') {
      const last = out[out.length - 1];
      if (last && last.kind === 'tool') last.callIds.push(seg.callId);
      else out.push({ kind: 'tool', callIds: [seg.callId] });
    } else {
      out.push({ kind: 'notice', notice: seg.notice });
    }
  }
  return out;
}

const NOTICE_TEXT: Record<ContextNotice['reason'], string> = {
  compacted: '上下文已压缩',
  compaction_failed: '上下文压缩失败，已回退',
  tool_result_compressed: '工具结果已压缩',
  truncated: '历史消息已截断',
};

function ContextNoticeChip({ notice }: { notice: ContextNotice }) {
  const label = NOTICE_TEXT[notice.reason] ?? '上下文调整';
  return (
    <div className="flex items-center gap-1.5 rounded bg-bg-inset px-2 py-1 text-xs text-text-tertiary">
      <Info size={11} className="shrink-0" />
      <span>{label}</span>
      {typeof notice.removedMessages === 'number' && <span>移除 {notice.removedMessages} 条</span>}
      {typeof notice.estimatedTokensBefore === 'number' && typeof notice.estimatedTokensAfter === 'number' && (
        <span className="font-mono">
          {notice.estimatedTokensBefore} → {notice.estimatedTokensAfter} tokens
        </span>
      )}
    </div>
  );
}

function StreamingCursor() {
  return (
    <span className="inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-accent align-middle" aria-label="正在输出" />
  );
}

/** 首 token 空窗 / 推理流：把「模型在想什么」显式呈现，避免长时间白屏被误判为卡死 */
function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  // 流式期默认展开（让等待有内容可看）；结束后默认折叠，避免长推理挤占正文。
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? streaming;
  return (
    <div className="rounded-md border border-border-subtle bg-bg-inset">
      <button
        type="button"
        onClick={() => setOverride(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-text-tertiary"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{streaming ? '思考中…' : '思考过程'}</span>
        {streaming && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />}
      </button>
      {open && (
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words border-t border-border-subtle px-2.5 py-1.5 text-xs text-text-tertiary">
          {text}
        </div>
      )}
    </div>
  );
}

function WaitingHint() {
  // R3：文案跟随服务端阶段——连接中 / 模型已响应 / 思考中，而不是一句笼统的「等待响应」。
  const stage = useRunStore((s) => s.stage?.stage ?? null);
  const label =
    stage === 'upstream_first_byte'
      ? '模型已响应，正在生成…'
      : stage === 'reasoning'
        ? '模型正在思考…'
        : '正在连接模型…';
  return (
    <div className="flex items-center gap-1.5 text-xs text-text-tertiary" role="status">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
      {label}
    </div>
  );
}
