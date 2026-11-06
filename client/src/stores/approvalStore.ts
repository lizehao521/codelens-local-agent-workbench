// 待确认审批存储 —— 服务端持有参数，前端只存「展示 + 令牌 + 倒计时」
// 纪律：拒绝/允许一律不乐观更新，卡片终态由服务端在原 SSE 流推 tool_result 驱动。

import { create } from 'zustand';
import type { AgentApprovalPayload, ApprovalReceipt, ApprovalVM } from '../types';
import { MISMATCH_ABORT_THRESHOLD } from '../lib/approval-receipt';

export interface ApprovalState {
  /** 待确认挑战：callId → VM（同一 callId 只保留最新一条） */
  byCallId: Record<string, ApprovalVM>;
  /** 当前会话内已记住的授权条数（allow_session 累加） */
  grantedCount: number;

  upsert: (payload: AgentApprovalPayload) => void;
  setReceipt: (callId: string, receipt: ApprovalReceipt) => void;
  /** 令牌/参数不匹配：累加计数并返回新计数 */
  bumpMismatch: (callId: string) => number;
  clearReceipt: (callId: string) => void;
  /** 两步确认：用户确认某非终步后锁定，等待下一步挑战到达 */
  ackPass: (callId: string) => void;
  /** AUDIT-009：续期成功后用新令牌 / 过期时间更新展示态 */
  refresh: (callId: string, token: string, expiresAt: number) => void;
  /** 移动端下滑收起 —— 保留 pending，绝不等于拒绝 */
  setCollapsed: (callId: string, collapsed: boolean) => void;
  remove: (callId: string) => void;
  grantSession: () => void;
  reset: () => void;
}

export const useApprovalStore = create<ApprovalState>((set, get) => ({
  byCallId: {},
  grantedCount: 0,

  upsert: (payload) =>
    set((state) => {
      // AUDIT-005 客户端：two_step 模式下，同 callId 的第二次挑战（不同
      // approvalId）代表「第二步」，须把步进 +1 而非当成新挑战从 1 开始。
      const prev = state.byCallId[payload.callId];
      const isTwoStepReseat =
        payload.approvalMode === 'two_step' &&
        prev !== undefined &&
        prev.approvalMode === 'two_step' &&
        prev.approvalId !== payload.approvalId;
      const pass = isTwoStepReseat ? (prev.pass ?? 1) + 1 : 1;
      const totalPasses = payload.approvalMode === 'two_step' ? 2 : undefined;
      return {
        byCallId: {
          ...state.byCallId,
          [payload.callId]: {
            approvalId: payload.approvalId,
            callId: payload.callId,
            token: payload.approvalToken,
            name: payload.name,
            ...(payload.displayName ? { displayName: payload.displayName } : {}),
            arguments: payload.arguments,
            risk: payload.risk,
            approvalMode: payload.approvalMode,
            reason: payload.reason,
            expiresAt: payload.expiresAt,
            mismatchCount: 0,
            effect: payload.effect ?? null,
            ...(totalPasses ? { pass, totalPasses } : {}),
            // 新挑战到达即解除上一步的「等待下一步」锁定
            awaitingNextStep: false,
          },
        },
      };
    }),

  setReceipt: (callId, receipt) =>
    set((state) => {
      const prev = state.byCallId[callId];
      if (!prev) return state;
      return { byCallId: { ...state.byCallId, [callId]: { ...prev, receipt } } };
    }),

  bumpMismatch: (callId) => {
    const prev = get().byCallId[callId];
    if (!prev) return 0;
    const next = prev.mismatchCount + 1;
    set((state) => ({
      byCallId: { ...state.byCallId, [callId]: { ...prev, mismatchCount: next } },
    }));
    return next;
  },

  clearReceipt: (callId) =>
    set((state) => {
      const prev = state.byCallId[callId];
      if (!prev) return state;
      return { byCallId: { ...state.byCallId, [callId]: { ...prev, receipt: undefined } } };
    }),

  ackPass: (callId) =>
    set((state) => {
      const prev = state.byCallId[callId];
      if (!prev) return state;
      return { byCallId: { ...state.byCallId, [callId]: { ...prev, awaitingNextStep: true } } };
    }),

  refresh: (callId, token, expiresAt) =>
    set((state) => {
      const prev = state.byCallId[callId];
      if (!prev) return state;
      return { byCallId: { ...state.byCallId, [callId]: { ...prev, token, expiresAt, awaitingNextStep: false } } };
    }),

  setCollapsed: (callId, collapsed) =>
    set((state) => {
      const prev = state.byCallId[callId];
      if (!prev) return state;
      return { byCallId: { ...state.byCallId, [callId]: { ...prev, collapsed } } };
    }),

  remove: (callId) =>
    set((state) => {
      if (!state.byCallId[callId]) return state;
      const next = { ...state.byCallId };
      delete next[callId];
      return { byCallId: next };
    }),

  grantSession: () => set((state) => ({ grantedCount: state.grantedCount + 1 })),

  reset: () => set({ byCallId: {}, grantedCount: 0 }),
}));

/** 待确认条数（PendingApprovalHint 用） */
export function selectPendingApprovals(): ApprovalVM[] {
  return Object.values(useApprovalStore.getState().byCallId).filter((a) => !a.receipt?.disabled);
}

/** 单条挑战选择器 */
export function useApproval(callId: string): ApprovalVM | undefined {
  return useApprovalStore((s) => s.byCallId[callId]);
}

/** 令牌是否已过期（5 分钟） */
export function isExpired(approval: ApprovalVM, now: number = Date.now()): boolean {
  return approval.expiresAt <= now;
}

/** 是否已熔断锁定 */
export function isAborted(approval: ApprovalVM): boolean {
  return (approval.mismatchCount ?? 0) >= MISMATCH_ABORT_THRESHOLD;
}
