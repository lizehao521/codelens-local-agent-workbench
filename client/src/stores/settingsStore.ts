// 设置状态（BYOK + 主题）—— zustand + localStorage 持久化（键 codeagent.settings.v1）

import { create } from 'zustand';
import type { Provider, Settings, ThemeMode } from '../types';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../lib/storage';
import { getProviders } from '../services/api';
import { useUiStore } from './uiStore';

/** spec §5 Provider 注册表：服务端 /providers 拉取失败时的兜底（与 spec 锁定一致） */
export const FALLBACK_PROVIDERS: Provider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: [
      { id: 'deepseek-chat', name: 'deepseek-chat' },
      { id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
    ],
    defaultModel: 'deepseek-chat',
    docsUrl: 'https://platform.deepseek.com/api-docs',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-4.6', name: 'glm-4.6' },
      { id: 'glm-4.5-air', name: 'glm-4.5-air' },
    ],
    defaultModel: 'glm-4.6',
    docsUrl: 'https://open.bigmodel.cn/dev/api',
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [
      { id: 'kimi-k2', name: 'kimi-k2' },
      { id: 'moonshot-v1-8k', name: 'moonshot-v1-8k' },
    ],
    defaultModel: 'kimi-k2',
    docsUrl: 'https://platform.moonshot.cn/docs',
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen-max', name: 'qwen-max' },
      { id: 'qwen-plus', name: 'qwen-plus' },
    ],
    defaultModel: 'qwen-plus',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
      { id: 'gpt-4o', name: 'gpt-4o' },
    ],
    defaultModel: 'gpt-4o-mini',
    docsUrl: 'https://platform.openai.com/docs',
  },
  {
    id: 'custom',
    name: '自定义 OpenAI 兼容端点',
    baseUrl: '',
    models: [],
    defaultModel: '',
    docsUrl: '',
  },
];

/** theme=system 时按系统偏好解析为 dark/light（与 index.html 内联脚本一致） */
export function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode !== 'system') return mode;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

/** 将解析后的主题写到 <html data-theme> */
export function applyResolvedTheme(mode: ThemeMode): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', resolveTheme(mode));
  }
}

interface SettingsState {
  settings: Settings;
  providers: Provider[];
  providersLoaded: boolean;
  providersLoading: boolean;
  providersError: string | null;
  update: (patch: Partial<Settings>) => void;
  /** 切换 provider 时联动重置为该 provider 默认模型 */
  selectProvider: (providerId: string) => void;
  setTheme: (theme: ThemeMode) => void;
  setProviders: (providers: Provider[]) => void;
  /** 从服务端重新拉取 provider/模型目录；notify=true 时通过 Toast 反馈结果。 */
  refreshProviders: (notify?: boolean) => Promise<void>;
  hasApiKey: () => boolean;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: loadSettings(),
  providers: FALLBACK_PROVIDERS,
  providersLoaded: false,
  providersLoading: false,
  providersError: null,

  update: (patch) => {
    const next = { ...get().settings, ...patch };
    if (patch.theme) applyResolvedTheme(patch.theme);
    set({ settings: next });
    if (!saveSettings(next)) {
      // 写入失败（配额耗尽）：保留内存态，由 UI 层 Toast 提示
      useUiStore.getState().pushToast({ message: '设置保存失败：浏览器存储空间不足', variant: 'error' });
    }
  },

  selectProvider: (providerId) => {
    const provider = get().providers.find((p) => p.id === providerId) ?? FALLBACK_PROVIDERS.find((p) => p.id === providerId);
    const patch: Partial<Settings> = { provider: providerId };
    // 切换到有模型的 provider 时，始终落到一个有效模型（defaultModel 无效则取第一个），
    // 避免 model 落空导致请求被服务端以「model Too small」拒绝。
    if (provider && provider.models.length > 0) {
      const candidate =
        provider.defaultModel && provider.models.some((m) => m.id === provider.defaultModel)
          ? provider.defaultModel
          : provider.models[0].id;
      patch.model = candidate;
    }
    get().update(patch);
  },

  setTheme: (theme) => {
    get().update({ theme });
  },

  setProviders: (providers) => {
    if (!Array.isArray(providers) || providers.length === 0) return;
    set({ providers, providersLoaded: true });
    // 当前 provider 的模型若不在新列表中，回退到一个有效模型（defaultModel 无效则取第一个）；
    // 回退值绝不为空字符串，避免 model 落空触发服务端「model Too small」校验失败。
    // 当前 provider 无模型（如自定义）时保留原 model，不强制清空。
    const { settings } = get();
    const current = providers.find((p) => p.id === settings.provider);
    if (current && current.models.length > 0) {
      const modelStillValid = current.models.some((m) => m.id === settings.model);
      if (!modelStillValid) {
        const fallback =
          current.defaultModel && current.models.some((m) => m.id === current.defaultModel)
            ? current.defaultModel
            : current.models[0].id;
        get().update({ model: fallback });
      }
    }
  },

  hasApiKey: () => get().settings.apiKey.trim().length > 0,

  refreshProviders: async (notify = false) => {
    if (get().providersLoading) return; // 幂等：连续点击不并发
    set({ providersLoading: true, providersError: null });
    try {
      const list = await getProviders();
      if (list.length > 0) get().setProviders(list);
      set({ providersLoading: false, providersError: null });
      if (notify) {
        useUiStore.getState().pushToast({ message: '模型列表已刷新', variant: 'success' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '未知错误';
      // 降级：保留当前目录（可能是 FALLBACK），置错误态供 UI 显示异常条 + 重试
      set({ providersLoading: false, providersError: msg });
      if (notify) {
        useUiStore.getState().pushToast({ message: `刷新模型列表失败：${msg}`, variant: 'error' });
      }
    }
  },
}));

export { DEFAULT_SETTINGS };
