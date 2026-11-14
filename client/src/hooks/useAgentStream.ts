// Agent SSE 编排 hook —— 十事件分流到四个 store
// 纪律（spec §6 / 性能）：delta 50ms 节流合并落段；工具四事件只改 toolCallStore 单卡引用；
// 审批只进 approvalStore；done/error 收尾后 reconcile 以服务端权威数据为准。

import { useCallback, useRef, useState } from 'react';
import type {
  AgentApprovalDedupPayload,
  AgentApprovalPayload,
  AgentContextNoticePayload,
  AgentDonePayload,
  AgentErrorPayload,
  AgentMetaPayload,
  AgentStagePayload,
  AgentStreamRequest,
  AgentToolCallPayload,
  AgentToolProgressPayload,
  AgentToolResultPayload,
  ContextNotice,
  Segment,
  ReviewResult,
  RunReport,
  SandboxGrantRequest,
  SessionMessageRow,
  ToolCallVM,
} from '../types';
import { openAgentStream, parseAgentSSE } from '../services/stream';
import { useServerSessionStore } from '../stores/serverSessionStore';
import { useToolCallStore } from '../stores/toolCallStore';
import { useApprovalStore } from '../stores/approvalStore';
import { useRunStore } from '../stores/runStore';
import { createId } from '../lib/format';

const FLUSH_INTERVAL = 50;

// 工具调用卡片：把 {type:'tool', callId} 段幂等追加到消息 segments。
// 否则 AssistantSegments 的 tool 组永远为空——SSE 高频工具事件只更新 toolCallStore，
// 若不在此处补充 segment，工具卡不会出现在消息正文里（B-01 / F-01）。
function appendToolSegment(messageId: string, callId: string): void {
  if (!messageId || !callId) return;
  const store = useServerSessionStore.getState();
  const target = store.messages.find((m) => m.id === messageId);
  if (!target) return;
  const segs = target.segments ?? [];
  if (segs.some((s) => s.type === 'tool' && s.callId === callId)) return;
  store.updateLocalMessage(messageId, { segments: [...segs, { type: 'tool', callId }] });
}

export interface AgentRunContext {
  /** 已本地插入的 assistant 占位消息 id */
  messageId: string;
}

// 模块级注册表：切会话等跨组件场景可中止当前流
let activeController: AbortController | null = null;

export function abortActiveRun(): boolean {
  if (activeController) {
    activeController.abort();
    return true;
  }
  return false;
}

export function isRunActive(): boolean {
  return activeController !== null;
}

export function useAgentStream() {
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const ctxRef = useRef<AgentRunContext | null>(null);
  const pendingTextRef = useRef('');
  const pendingReasoningRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settledRef = useRef(false);
  const startedAtRef = useRef(0);

  const flush = useCallback((): void => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const ctx = ctxRef.current;
    if (!ctx) return;
    const store = useServerSessionStore.getState();
    const target = store.messages.find((m) => m.id === ctx.messageId);
    if (!target) return;

    const text = pendingTextRef.current;
    const reasoning = pendingReasoningRef.current;
    if (!text && !reasoning) return;
    pendingTextRef.current = '';
    pendingReasoningRef.current = '';

    const segments: Segment[] = (target.segments ?? []).map((seg) => ({ ...seg }));
    if (text) {
      const last = segments[segments.length - 1];
      if (last && last.type === 'text') last.text += text;
      else segments.push({ type: 'text', text });
    }
    // 推理文本按帧累加：每次 flush 只带增量，若直接覆盖会让「已思考的部分」每 50ms 被冲掉。
    const nextReasoning = reasoning ? `${target.reasoningText ?? ''}${reasoning}` : undefined;
    store.updateLocalMessage(ctx.messageId, {
      segments,
      ...(nextReasoning !== undefined ? { reasoningText: nextReasoning } : {}),
    } as Partial<SessionMessageRow>);
  }, []);

  const scheduleFlush = useCallback((): void => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flush();
    }, FLUSH_INTERVAL);
  }, [flush]);

  const settle = useCallback(
    (patch: { status: 'done' | 'error' | 'aborted'; error?: AgentErrorPayload }): void => {
      flush();
      const ctx = ctxRef.current;
      if (ctx) {
        useServerSessionStore.getState().updateLocalMessage(ctx.messageId, { status: patch.status });
      }
      settledRef.current = true;
    },
    [flush],
  );

  const abort = useCallback((): void => {
    controllerRef.current?.abort();
  }, []);

  const start = useCallback(
    async (request: AgentStreamRequest, ctx: AgentRunContext): Promise<void> => {
      const controller = new AbortController();
      controllerRef.current = controller;
      activeController = controller;
      ctxRef.current = ctx;
      pendingTextRef.current = '';
      pendingReasoningRef.current = '';
      settledRef.current = false;
      startedAtRef.current = Date.now();
      setError(null);
      useRunStore.getState().beginRun();

      try {
        const res = await openAgentStream(request, controller.signal);

        if (!res.ok) {
          let code = `HTTP_${res.status}`;
          let message = `请求失败（HTTP ${res.status}）`;
          try {
            const data = (await res.json()) as { error?: { code?: string; message?: string } };
            if (data.error?.code) code = data.error.code;
            if (data.error?.message) message = data.error.message;
          } catch {
            /* 非 JSON 错误响应 */
          }
          const payload = { code, message };
          setError(payload);
          useRunStore.getState().failRun(payload);
          settle({ status: 'error', error: payload });
          return;
        }

        await parseAgentSSE(res, {
          onStage: (data: AgentStagePayload) => {
            // R3：connecting 一到达就进入等待态；后续阶段只更新状态文案与计时基准。
            useRunStore.getState().applyStage(data);
          },
          onMeta: (meta: AgentMetaPayload) => {
            if (settledRef.current) return;
            useRunStore.getState().applyMeta(meta);
          },
          onDelta: (data) => {
            if (!data.text || settledRef.current) return;
            pendingTextRef.current += data.text;
            scheduleFlush();
          },
          onReasoning: (data) => {
            if (!data.text || settledRef.current) return;
            pendingReasoningRef.current += data.text;
            scheduleFlush();
          },
          onToolCall: (data: AgentToolCallPayload) => {
            if (settledRef.current) return;
            const messageId = ctxRef.current?.messageId ?? '';
            useToolCallStore.getState().upsertToolCall(data, messageId, Date.now());
            appendToolSegment(messageId, data.callId);
          },
          onToolProgress: (data: AgentToolProgressPayload) => {
            if (settledRef.current) return;
            useToolCallStore.getState().setProgress(data);
          },
          onToolResult: (data: AgentToolResultPayload) => {
            if (settledRef.current) return;
            useToolCallStore.getState().applyResult(data, Date.now());
          },
          onApproval: (data: AgentApprovalPayload) => {
            if (settledRef.current) return;
            useApprovalStore.getState().upsert(data);
            useToolCallStore.getState().attachApproval(data);
          },
          onApprovalDedup: (data: AgentApprovalDedupPayload) => {
            if (settledRef.current) return;
            useToolCallStore.getState().applyDedup(data);
          },
          onResultReview: (data: { callId: string; reviewPending: boolean; diff?: ToolCallVM['diff'] }) => {
            if (settledRef.current) return;
            if (data.reviewPending) useToolCallStore.getState().markReviewPending(data.callId, data.diff);
          },
          onReviewResult: (data: { callId: string; result: ReviewResult }) => {
            if (settledRef.current) return;
            useToolCallStore.getState().setReview(data.callId, data.result);
          },
          onSandboxGrant: (data: SandboxGrantRequest) => {
            if (settledRef.current) return;
            useRunStore.getState().setPendingGrant(data);
          },
          onRunReport: (data: RunReport) => {
            // 汇报是「事后补充」，紧跟 done/error 到达也可能在 settle 之后；
            // 因此不因 settledRef 丢弃，只写 runStore 展示。
            useRunStore.getState().applyRunReport(data);
          },
          onContextNotice: (data: AgentContextNoticePayload) => {
            if (settledRef.current) return;
            const messageId = ctxRef.current?.messageId ?? '';
            const notice: ContextNotice = { id: createId('notice'), ...data };
            const store = useServerSessionStore.getState();
            const target = store.messages.find((m) => m.id === messageId);
            if (!target) return;
            const segments: Segment[] = [...(target.segments ?? []), { type: 'notice', notice }];
            store.updateLocalMessage(messageId, { segments });
          },
          onDone: (data: AgentDonePayload) => {
            if (settledRef.current) return;
            useRunStore.getState().applyDone(data, Date.now() - startedAtRef.current);
            settle({ status: 'done' });
            void useServerSessionStore.getState().reconcileAfterRun();
          },
          onError: (data: AgentErrorPayload) => {
            if (settledRef.current) return;
            setError(data);
            useRunStore.getState().failRun(data);
            settle({ status: 'error', error: data });
          },
        });

        // 流自然结束但既无 done 也无 error 帧
        if (!settledRef.current) {
          if (controller.signal.aborted) {
            settle({ status: 'aborted' });
            useRunStore.getState().reset();
          } else {
            const payload = { code: 'NETWORK_ERROR', message: '流式响应异常中断，请重试' };
            setError(payload);
            useRunStore.getState().failRun(payload);
            settle({ status: 'error', error: payload });
          }
        }
      } catch (err) {
        if (controller.signal.aborted) {
          settle({ status: 'aborted' });
          useRunStore.getState().reset();
        } else {
          const message = err instanceof Error ? err.message : '网络请求失败';
          const payload = { code: 'NETWORK_ERROR', message };
          setError(payload);
          useRunStore.getState().failRun(payload);
          settle({ status: 'error', error: payload });
        }
      } finally {
        activeController = null;
        controllerRef.current = null;
      }
    },
    [scheduleFlush, settle],
  );

  const clearError = useCallback((): void => {
    setError(null);
    useRunStore.getState().reset();
  }, []);

  return { error, start, abort, clearError };
}
