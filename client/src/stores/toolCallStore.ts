// 工具调用归一化存储 —— SSE 四事件（tool_call / tool_progress / tool_result / approval）只改这里
// 性能纪律：tool segment 只存 callId，事件到达只替换 byId[callId] 一个对象引用，
// 不重写消息的 segments 数组（否则整条 assistant 消息每帧全量 re-render）。

import { create } from 'zustand';
import type {
  ReviewResult,
  AgentApprovalDedupPayload,
  AgentApprovalPayload,
  AgentToolCallPayload,
  AgentToolProgressPayload,
  AgentToolResultPayload,
  SessionToolCallRow,
  ToolCallStatus,
  ToolCallVM,
} from '../types';
import { detectResultKind } from '../lib/tool-preview';

export interface ToolCallState {
  byId: Record<string, ToolCallVM>;
  /** messageId → 该消息内的 callId 序列（时序） */
  byMessage: Record<string, string[]>;

  upsertToolCall: (payload: AgentToolCallPayload, messageId: string, now: number) => void;
  setProgress: (payload: AgentToolProgressPayload) => void;
  applyResult: (payload: AgentToolResultPayload, now: number) => void;
  attachApproval: (payload: AgentApprovalPayload) => void;
  /** E：可逆写入沿用上次授权，卡片上只追加一行提示（不弹审批卡）。 */
  applyDedup: (payload: AgentApprovalDedupPayload) => void;
  /** R6：可逆调用已执行，先标「复核中」，结论稍后并行回填。 */
  markReviewPending: (callId: string) => void;
  /** R6：复核结论回填（只展示事实指摘，不展示主脑推理）。 */
  setReview: (callId: string, review: ReviewResult) => void;
  /**
   * P1-6 回看水合：用服务端详情里的审计行整体重建 byId / byMessage。
   * 刷新或跨设备恢复后，消息 segments 里的 tool 段引用的就是这些 callId——
   * 不水合则全部卡片渲染 null（工具时间线整体丢失）。
   * 语义 = 整体替换（不是合并）：当前会话的权威状态以服务端为准。
   */
  hydrate: (rows: SessionToolCallRow[]) => void;
  /** 同卡重试上限 3 次，超出按钮 disabled；返回是否允许再重试 */
  canRetry: (callId: string) => boolean;
  markRetry: (callId: string) => void;
  markRetrySuccess: (callId: string) => void;
  reset: () => void;
}

export const MAX_RETRY_PER_CALL = 3;

/**
 * 审计行 → 视图模型（P1-6）。详情不返回完整 resultText（resultRef 指向落盘
 * 工件，无读取端点），结果区以 resultSummary 为展示上限；errorMessage 是
 * 服务端落库的错误原文，缺失时按 errorKind 合成占位文案。
 */
export function rowToToolCallVM(row: SessionToolCallRow): ToolCallVM {
  const summary = row.resultSummary ?? undefined;
  const errorMessage = row.errorMessage ?? (row.errorKind ? `调用失败（${row.errorKind}）` : undefined);
  return {
    callId: row.callId,
    name: row.toolName,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    category: row.category,
    source: row.source,
    risk: row.risk,
    approvalMode: row.approvalMode,
    arguments: row.arguments,
    status: row.status,
    iteration: row.iteration,
    ...(typeof row.startedAt === 'number' ? { startedAt: row.startedAt } : {}),
    ...(typeof row.endedAt === 'number' ? { endedAt: row.endedAt } : {}),
    ...(typeof row.durationMs === 'number' ? { durationMs: row.durationMs } : {}),
    ...(summary ? { summary } : {}),
    ...(summary ? { resultText: summary } : {}),
    ...(summary ? { resultKind: detectResultKind(summary) } : {}),
    ...(row.truncated ? { truncated: true } : {}),
    ...(errorMessage
      ? {
          error: {
            code: row.errorKind ?? 'TOOL_FAILED',
            kind: row.errorKind ?? undefined,
            message: errorMessage,
          },
        }
      : {}),
    retryCount: 0,
  };
}

/** 结果对象 → 可展示文本（MCP 的 content[] 形态也一并处理） */
function serializeResult(data: unknown): string {
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data;
  if (typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const parts = record.content
        .map((c) => {
          if (typeof c === 'string') return c;
          const item = c as Record<string, unknown>;
          return typeof item.text === 'string' ? item.text : JSON.stringify(item, null, 2);
        })
        .filter(Boolean);
      if (parts.length > 0) return parts.join('\n');
    }
    if (typeof record.text === 'string') return record.text;
    if (typeof record.body === 'string') return record.body;
    return JSON.stringify(data, null, 2);
  }
  return String(data);
}

function resultMeta(data: unknown): { contentType?: string; bytes?: number; artifactPath?: string } {
  if (typeof data !== 'object' || data === null) return {};
  const record = data as Record<string, unknown>;
  const meta: { contentType?: string; bytes?: number; artifactPath?: string } = {};
  if (typeof record.contentType === 'string') meta.contentType = record.contentType;
  if (typeof record.bytes === 'number') meta.bytes = record.bytes;
  if (typeof record.artifactPath === 'string') meta.artifactPath = record.artifactPath;
  return meta;
}

export const useToolCallStore = create<ToolCallState>((set, get) => ({
  byId: {},
  byMessage: {},

  upsertToolCall: (payload, messageId, now) =>
    set((state) => {
      const prev = state.byId[payload.callId];
      const call: ToolCallVM = {
        callId: payload.callId,
        name: payload.name,
        ...(payload.displayName ? { displayName: payload.displayName } : {}),
        category: payload.category,
        source: payload.source ?? 'builtin',
        risk: payload.risk,
        approvalMode: payload.approvalMode,
        arguments: payload.arguments,
        // 无审批即执行：收到 tool_call 即视为已开始
        status: payload.approvalMode === 'none' ? 'running' : 'pending',
        iteration: payload.iteration,
        startedAt: prev?.startedAt ?? now,
        ...(prev?.summary ? { summary: prev.summary } : {}),
        ...(prev?.approvalId ? { approvalId: prev.approvalId } : {}),
        retryCount: prev?.retryCount ?? 0,
        ...(prev?.retrySucceededAfter ? { retrySucceededAfter: prev.retrySucceededAfter } : {}),
      };
      const known = state.byMessage[messageId] ?? [];
      return {
        byId: { ...state.byId, [payload.callId]: call },
        byMessage: known.includes(payload.callId)
          ? state.byMessage
          : { ...state.byMessage, [messageId]: [...known, payload.callId] },
      };
    }),

  setProgress: (payload) =>
    set((state) => {
      const prev = state.byId[payload.callId];
      if (!prev) return state;
      const text = payload.message ?? payload.stage;
      return {
        byId: {
          ...state.byId,
          [payload.callId]: {
            ...prev,
            status: prev.status === 'pending' ? 'running' : prev.status,
            progress: text,
          },
        },
      };
    }),

  applyResult: (payload, now) =>
    set((state) => {
      const prev = state.byId[payload.callId];
      if (!prev) return state;
      const text = serializeResult(payload.data);
      const meta = resultMeta(payload.data);
      const succeeded = payload.status === 'success';
      const retried = prev.retryCount > 0 && succeeded;
      const next: ToolCallVM = {
        ...prev,
        name: payload.name || prev.name,
        status: payload.status,
        endedAt: now,
        ...(typeof payload.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
        ...(payload.summary ? { summary: payload.summary } : {}),
        ...(text ? { resultText: text, resultKind: detectResultKind(text) } : {}),
        ...(meta.contentType ? { contentType: meta.contentType } : {}),
        ...(typeof meta.bytes === 'number' ? { bytes: meta.bytes } : {}),
        ...(meta.artifactPath ? { artifactPath: meta.artifactPath } : {}),
        ...(payload.resultId ? { resultId: payload.resultId } : {}),
        ...(payload.truncated ? { truncated: true } : {}),
        ...(payload.error ? { error: payload.error } : {}),
        ...(retried ? { retrySucceededAfter: prev.retryCount } : {}),
      };
      return { byId: { ...state.byId, [payload.callId]: next } };
    }),

  attachApproval: (payload) =>
    set((state) => {
      const prev = state.byId[payload.callId];
      if (!prev) return state;
      return {
        byId: {
          ...state.byId,
          [payload.callId]: {
            ...prev,
            approvalId: payload.approvalId,
            approvalMode: payload.approvalMode,
            risk: payload.risk,
            arguments: payload.arguments,
            status: 'pending',
            ...(payload.displayName ? { displayName: payload.displayName } : {}),
          },
        },
      };
    }),

  applyDedup: (payload) =>
    set((state) => {
      const prev = state.byId[payload.callId];
      if (!prev) return state;
      return {
        byId: {
          ...state.byId,
          [payload.callId]: {
            ...prev,
            status: prev.status === 'pending' ? 'running' : prev.status,
            dedupNote: {
              grantId: payload.reusedGrantId,
              step: payload.reusedStep,
              text: payload.text,
            },
          },
        },
      };
    }),

  markReviewPending: (callId) =>
    set((state) => {
      const prev = state.byId[callId];
      if (!prev) return state;
      return { byId: { ...state.byId, [callId]: { ...prev, reviewPending: true } } };
    }),

  setReview: (callId, review) =>
    set((state) => {
      const prev = state.byId[callId];
      if (!prev) return state;
      return { byId: { ...state.byId, [callId]: { ...prev, review, reviewPending: false } } };
    }),

  hydrate: (rows) =>
    set(() => {
      const byId: Record<string, ToolCallVM> = {};
      const byMessage: Record<string, string[]> = {};
      for (const row of rows) {
        byId[row.callId] = rowToToolCallVM(row);
        // message_id 为空（所属消息已被 resume 删除）→ 不挂靠任何消息，
        // 与 segments 中不存在对应 tool 段保持一致。
        const messageId = row.messageId;
        if (!messageId) continue;
        const known = byMessage[messageId] ?? [];
        if (!known.includes(row.callId)) byMessage[messageId] = [...known, row.callId];
      }
      return { byId, byMessage };
    }),

  canRetry: (callId) => {
    const call = get().byId[callId];
    if (!call) return false;
    return call.retryCount < MAX_RETRY_PER_CALL;
  },

  markRetry: (callId) =>
    set((state) => {
      const prev = state.byId[callId];
      if (!prev) return state;
      return {
        byId: {
          ...state.byId,
          [callId]: {
            ...prev,
            retryCount: prev.retryCount + 1,
            status: 'running',
            progress: '正在重试…',
            endedAt: undefined,
            durationMs: undefined,
          },
        },
      };
    }),

  markRetrySuccess: (callId) =>
    set((state) => {
      const prev = state.byId[callId];
      if (!prev) return state;
      return { byId: { ...state.byId, [callId]: { ...prev, status: 'success' } } };
    }),

  reset: () => set({ byId: {}, byMessage: {} }),
}));

/** 单卡选择器：只有该 callId 变化时组件才 re-render */
export function useToolCall(callId: string): ToolCallVM | undefined {
  return useToolCallStore((s) => s.byId[callId]);
}

/** 该消息内全部调用（按 callId 顺序解析） */
export function selectMessageCalls(messageId: string): ToolCallVM[] {
  const state = useToolCallStore.getState();
  const ids = state.byMessage[messageId] ?? [];
  return ids.map((id) => state.byId[id]).filter((c): c is ToolCallVM => !!c);
}

/** 未成功数（唯一口径，与 lib/tool-grouping 保持一致） */
export function countUnsuccessful(calls: ToolCallVM[]): number {
  return calls.filter((c) => c.status === 'failed' || c.status === 'timeout').length;
}

/** 状态是否终态 */
export function isTerminal(status: ToolCallStatus): boolean {
  return status === 'success' || status === 'failed' || status === 'timeout' || status === 'rejected' || status === 'skipped';
}
