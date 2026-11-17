// 当前运行态 —— meta 事件驱动的运行参数 + done 收尾的成本信息
// 与消息/工具/审批存储解耦：占用条、Inspector、输入框各自订阅互不牵连

import { create } from 'zustand';
import type {
  AgentMetaPayload,
  AgentDonePayload,
  AgentStagePayload,
  ResumeConflict,
  RunReport,
  SandboxGrantRequest,
} from '../types';

export interface RunMeta {
  sessionId: string;
  messageId?: string;
  provider: string;
  model: string;
  channel: 'native' | 'react';
  degraded: boolean;
  degradedReason: string | null;
  iteration: number;
  maxIterations: number;
  contextWindow?: number;
  estimatedPromptTokens?: number;
  toolCount?: number;
}

export interface RunState {
  streaming: boolean;
  meta: RunMeta | null;
  /** done 事件的任务成本（仅当次运行） */
  run: (AgentDonePayload & { elapsedMs: number }) | null;
  /** 流级错误（MISSING_API_KEY / UPSTREAM_* / NETWORK_ERROR） */
  error: { code: string; message: string } | null;
  /** R3：服务端阶段事件（connecting → upstream_first_byte → reasoning/content → done）。 */
  stage: AgentStagePayload | null;
  /** 客户端发出的请求时间，用于「已等待 N 秒」本地计时（不依赖服务端时钟）。 */
  acceptedAt: number | null;
  /** R6：RunState 汇报卡（仅「有实质变化才出」，或 RUN_REPORT_EVERY=1）。 */
  report: RunReport | null;
  /** 工作区外首次访问的目录授权请求（等待用户允许/拒绝）。 */
  pendingGrant: SandboxGrantRequest | null;
  /** F：当前 runId（阶段/汇报任一到达即记录），审计台按它取数。 */
  runId: string | null;
  /** F：阶段序列（右栏「它现在在干什么」），最多保留 30 条。 */
  stageHistory: AgentStagePayload[];
  /** F：续跑冲突态（C 的 409 结果），非空时展示冲突清单。 */
  resumeConflict: { runId: string; conflicts: ResumeConflict[] } | null;

  beginRun: () => void;
  applyStage: (stage: AgentStagePayload) => void;
  applyMeta: (meta: AgentMetaPayload) => void;
  applyDone: (done: AgentDonePayload, elapsedMs: number) => void;
  applyRunReport: (report: RunReport) => void;
  setPendingGrant: (grant: SandboxGrantRequest | null) => void;
  setResumeConflict: (conflict: { runId: string; conflicts: ResumeConflict[] } | null) => void;
  failRun: (error: { code: string; message: string }) => void;
  reset: () => void;
}

export const useRunStore = create<RunState>((set) => ({
  streaming: false,
  meta: null,
  run: null,
  error: null,
  stage: null,
  acceptedAt: null,
  report: null,
  pendingGrant: null,
  runId: null,
  stageHistory: [],
  resumeConflict: null,

  beginRun: () =>
    set({
      streaming: true,
      run: null,
      error: null,
      stage: null,
      acceptedAt: Date.now(),
      report: null,
      pendingGrant: null,
      runId: null,
      stageHistory: [],
      resumeConflict: null,
    }),

  applyStage: (stage) =>
    set((state) => {
      const nextHistory = [...state.stageHistory, stage].slice(-30);
      return { stage, runId: stage.runId ?? state.runId, stageHistory: nextHistory };
    }),

  applyMeta: (meta) =>
    set({
      meta: {
        sessionId: meta.sessionId,
        messageId: meta.messageId,
        provider: meta.provider,
        model: meta.model,
        channel: meta.channel,
        degraded: meta.degraded ?? false,
        degradedReason: meta.degradedReason ?? null,
        iteration: meta.iteration ?? 1,
        maxIterations: meta.maxIterations ?? 12,
        contextWindow: meta.contextWindow,
        estimatedPromptTokens: meta.estimatedPromptTokens,
        toolCount: meta.toolCount,
      },
    }),

  applyDone: (done, elapsedMs) =>
    set({ streaming: false, run: { ...done, elapsedMs } }),

  applyRunReport: (report) => set({ report, runId: report.runId }),

  setPendingGrant: (pendingGrant) => set({ pendingGrant }),

  setResumeConflict: (resumeConflict) => set({ resumeConflict }),

  failRun: (error) => set({ streaming: false, error }),

  reset: () =>
    set({
      streaming: false,
      meta: null,
      run: null,
      error: null,
      stage: null,
      acceptedAt: null,
      report: null,
      pendingGrant: null,
      runId: null,
      stageHistory: [],
      resumeConflict: null,
    }),
}));
