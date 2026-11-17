// UI 状态（v2.0 Agent 工作台）—— 移动端 Tab / 抽屉 / 设置弹层 / Toast / 恢复码弹窗
// 移动端三 Tab（spec §7）：对话 / 工具 / 会话

import { create } from 'zustand';
import { createId } from '../lib/format';

export type MobileTab = 'chat' | 'tools' | 'history';
export type ToastVariant = 'info' | 'success' | 'error';

/** 主视图：会话工作台 / 审计台（由左侧导航切换） */
export type WorkspaceView = 'chat' | 'audit';

/** 能力面板：统一由 AppShell 挂载，导航与右栏都只负责“打开” */
export type CapabilityModal = 'judge' | 'rsi' | 'iteration' | 'sandbox' | 'skills';

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
}

interface UiState {
  mobileTab: MobileTab;
  setMobileTab: (tab: MobileTab) => void;

  workspaceView: WorkspaceView;
  setWorkspaceView: (view: WorkspaceView) => void;

  activeModal: CapabilityModal | null;
  openCapability: (modal: CapabilityModal) => void;
  closeCapability: () => void;

  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;

  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

  toasts: Toast[];
  pushToast: (toast: { message: string; variant?: ToastVariant }) => void;
  dismissToast: (id: string) => void;

  /** 恢复码一次性展示（AppShell 弹 RecoveryCodeModal） */
  recoveryCode: string | null;
  showRecoveryCode: (code: string) => void;
  hideRecoveryCode: () => void;

  /** 「跳到最新」（AgentMessageList 监听 nonce 变化） */
  chatScrollNonce: number;
  requestChatScroll: () => void;
}

const TOAST_DURATION = 2000;

export const useUiStore = create<UiState>((set, get) => ({
  mobileTab: 'chat',
  setMobileTab: (tab) => set({ mobileTab: tab }),

  workspaceView: 'chat',
  setWorkspaceView: (view) => set({ workspaceView: view }),

  activeModal: null,
  openCapability: (modal) => set({ activeModal: modal }),
  closeCapability: () => set({ activeModal: null }),

  sidebarOpen: false,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),

  toasts: [],
  pushToast: ({ message, variant = 'info' }) => {
    const id = createId('toast');
    set({ toasts: [...get().toasts, { id, message, variant }] });
    if (typeof window !== 'undefined') {
      window.setTimeout(() => get().dismissToast(id), TOAST_DURATION);
    }
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  recoveryCode: null,
  showRecoveryCode: (code) => set({ recoveryCode: code }),
  hideRecoveryCode: () => set({ recoveryCode: null }),

  chatScrollNonce: 0,
  requestChatScroll: () => set({ chatScrollNonce: get().chatScrollNonce + 1 }),
}));
