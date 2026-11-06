// 会话存储（v2.0 服务端持久化）—— 服务端 SQLite 是唯一事实源，本 store 是视图缓存
// 生命周期：loadList（GET /sessions）→ selectSession（GET /sessions/:id 详情重建 messages）
// 流式期间：appendLocalMessage / updateLocalMessage 只改内存，done 后以服务端为准可刷新
// AC-05：恢复码只在创建/重生成时明文一次；本 store 绝不持久化恢复码

import { create } from 'zustand';
import type { SessionMessageRow, ServerSession } from '../types';
import {
  createSession,
  deleteSession,
  getSessionDetail,
  listSessions,
  patchSession,
} from '../services/api';
import { useToolCallStore } from './toolCallStore';
import {
  loadActiveSessionId,
  loadDeviceToken,
  saveActiveSessionId,
  saveDeviceToken,
} from '../lib/device-store';

export interface ServerSessionState {
  sessions: ServerSession[];
  activeSessionId: string | null;
  /** 当前会话的消息（ segments 结构，tool 段只存 callId） */
  messages: SessionMessageRow[];
  deviceToken: string | null;
  listLoading: boolean;
  detailLoading: boolean;
  /** 最近一次列表/详情错误（不弹 Toast，由 UI 决定） */
  lastError: string | null;

  loadList: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  createOnServer: (input: { provider: string; model: string }) => Promise<{
    session: ServerSession;
    recoveryCode: string;
  }>;
  removeOnServer: (id: string) => Promise<void>;
  renameOnServer: (id: string, title: string) => Promise<void>;
  refreshDetail: () => Promise<void>;

  /** 流式回显：本地插入一条消息（不写服务端，done 后服务端已有权威数据） */
  appendLocalMessage: (message: SessionMessageRow) => void;
  updateLocalMessage: (messageId: string, patch: Partial<SessionMessageRow>) => void;
  /** AC-10 resume 本地回退：移除 messageId 及其后的消息 */
  removeLocalMessagesFrom: (messageId: string) => void;
  /** 流式收尾：用服务端权威数据覆盖本地（失败则保留本地） */
  reconcileAfterRun: () => Promise<void>;
}

export const useServerSessionStore = create<ServerSessionState>((set, get) => ({
  sessions: [],
  activeSessionId: loadActiveSessionId(),
  messages: [],
  deviceToken: loadDeviceToken(),
  listLoading: false,
  detailLoading: false,
  lastError: null,

  loadList: async () => {
    set({ listLoading: true, lastError: null });
    try {
      const token = get().deviceToken;
      const data = await listSessions(token);
      set({ sessions: data.items, listLoading: false });
      const active = get().activeSessionId;
      if (active && data.items.some((s) => s.id === active)) {
        await get().selectSession(active);
      } else if (data.items.length > 0) {
        await get().selectSession(data.items[0].id);
      } else {
        set({ activeSessionId: null, messages: [] });
        useToolCallStore.getState().reset();
        saveActiveSessionId(null);
      }
    } catch (err) {
      set({
        listLoading: false,
        lastError: err instanceof Error ? err.message : '会话列表加载失败',
      });
    }
  },

  selectSession: async (id) => {
    set({ detailLoading: true, activeSessionId: id, lastError: null });
    saveActiveSessionId(id);
    try {
      const detail = await getSessionDetail(id, get().deviceToken);
      // P1-6：详情里的 toolCalls 是工具审计链的权威数据——messages 的 tool 段
      // 只存 callId，不在此水合 toolCallStore，刷新/跨设备恢复后卡片全部渲染 null。
      useToolCallStore.getState().hydrate(detail.toolCalls ?? []);
      set({
        messages: detail.messages,
        sessions: detail.session
          ? get().sessions.map((s) => (s.id === id ? { ...s, ...detail.session } : s))
          : get().sessions,
        detailLoading: false,
      });
    } catch (err) {
      // 失败也清空工具存储：残留的上个会话卡片会错挂到新会话的消息上
      useToolCallStore.getState().reset();
      set({
        detailLoading: false,
        lastError: err instanceof Error ? err.message : '会话详情加载失败',
      });
    }
  },

  createOnServer: async (input) => {
    const data = await createSession(input);
    if (data.deviceToken) {
      saveDeviceToken(data.deviceToken);
      set({ deviceToken: data.deviceToken });
    }
    set((state) => ({
      sessions: [data.session, ...state.sessions],
      activeSessionId: data.session.id,
      messages: [],
    }));
    useToolCallStore.getState().reset();
    saveActiveSessionId(data.session.id);
    return { session: data.session, recoveryCode: data.recoveryCode };
  },

  removeOnServer: async (id) => {
    await deleteSession(id, get().deviceToken);
    const rest = get().sessions.filter((s) => s.id !== id);
    const wasActive = get().activeSessionId === id;
    set((state) => ({
      sessions: rest,
      activeSessionId: state.activeSessionId === id ? (rest[0]?.id ?? null) : state.activeSessionId,
      messages: state.activeSessionId === id ? [] : state.messages,
    }));
    if (wasActive) useToolCallStore.getState().reset();
    const nextActive = get().activeSessionId;
    saveActiveSessionId(nextActive);
    if (nextActive) await get().selectSession(nextActive);
  },

  renameOnServer: async (id, title) => {
    // 乐观更新，失败回滚
    const prev = get().sessions.find((s) => s.id === id);
    set({ sessions: get().sessions.map((s) => (s.id === id ? { ...s, title } : s)) });
    try {
      const data = await patchSession(id, { title }, get().deviceToken);
      set({ sessions: get().sessions.map((s) => (s.id === id ? { ...s, ...data.session } : s)) });
    } catch {
      if (prev) set({ sessions: get().sessions.map((s) => (s.id === id ? prev : s)) });
    }
  },

  refreshDetail: async () => {
    const id = get().activeSessionId;
    if (!id) return;
    await get().selectSession(id);
  },

  appendLocalMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  updateLocalMessage: (messageId, patch) =>
    set((state) => ({
      messages: state.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
    })),

  removeLocalMessagesFrom: (messageId) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;
      return { messages: state.messages.slice(0, idx) };
    }),

  reconcileAfterRun: async () => {
    await get().refreshDetail();
  },
}));

/** 当前会话（响应式） */
export function useActiveServerSession(): ServerSession | null {
  return useServerSessionStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
}
