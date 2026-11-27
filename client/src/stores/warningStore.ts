// Warning Store —— 管理 SSE warning 事件的 Zustand store
// 限制累积最多 100 条，超出时 LRU 淘汰最旧记录

import { create } from 'zustand';
import { createId } from '../lib/format';

export interface Warning {
  id: string;
  message: string;
  timestamp: number;
  variant: 'warning' | 'error';
}

interface WarningState {
  warnings: Warning[];
  maxWarnings: number;
  addWarning: (message: string, variant?: 'warning' | 'error') => void;
  removeWarning: (id: string) => void;
  clearWarnings: () => void;
}

const MAX_WARNINGS = 100;

export const useWarningStore = create<WarningState>((set) => ({
  warnings: [],
  maxWarnings: MAX_WARNINGS,

  addWarning: (message: string, variant: 'warning' | 'error' = 'warning') => {
    const id = createId('warn');
    const newWarning: Warning = {
      id,
      message,
      timestamp: Date.now(),
      variant,
    };

    set((state) => {
      const newWarnings = [...state.warnings, newWarning];
      // LRU 淘汰：超过最大数量时移除最旧的
      if (newWarnings.length > state.maxWarnings) {
        newWarnings.shift();
      }
      return { warnings: newWarnings };
    });
  },

  removeWarning: (id: string) => {
    set((state) => ({
      warnings: state.warnings.filter((w) => w.id !== id),
    }));
  },

  clearWarnings: () => {
    set({ warnings: [] });
  },
}));