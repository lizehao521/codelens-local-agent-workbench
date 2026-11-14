/** 输入区共享状态：执行方式 + 外部插件/推荐填入的草稿。 */
import { create } from 'zustand';

export type ExecutionMode = 'plan' | 'goal';

interface ComposerState {
  executionMode: ExecutionMode;
  setExecutionMode: (mode: ExecutionMode) => void;
  /** 插件/推荐写入的草稿；AgentInput 消费后清空，不自动发送。 */
  draft: string;
  setDraft: (draft: string) => void;
}

export const useComposerStore = create<ComposerState>((set) => ({
  executionMode: 'goal',
  setExecutionMode: (executionMode) => set({ executionMode }),
  draft: '',
  setDraft: (draft) => set({ draft }),
}));
