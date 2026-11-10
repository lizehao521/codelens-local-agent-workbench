// localStorage 持久化层（v2.0）—— 仅设置与设备标识；会话本体在服务端 SQLite
// 纯函数友好：所有导出函数不依赖 React，可在 vitest 中直接测试。

import type { Settings, ThemeMode } from '../types';

export const SETTINGS_KEY = 'codeagent.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  // 默认接入本地模型中转服务；密钥由 client/.env.local 在运行时注入，不写进源码/构建产物。
  provider: 'custom',
  model: '平衡',
  customBaseUrl: 'http://1.92.92.200:8787/v1',
  apiKey: '',
  theme: 'system',
  channelMode: 'auto',
};

const THEME_MODES: ThemeMode[] = ['system', 'dark', 'light'];
const CHANNEL_MODES = ['auto', 'native', 'react'];

export function sanitizeSettings(parsed: unknown): Settings {
  const raw = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const out: Settings = {
    provider: typeof raw.provider === 'string' && raw.provider ? raw.provider : DEFAULT_SETTINGS.provider,
    model: typeof raw.model === 'string' && raw.model ? raw.model : DEFAULT_SETTINGS.model,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    theme: THEME_MODES.includes(raw.theme as ThemeMode) ? (raw.theme as ThemeMode) : 'system',
  };
  if (typeof raw.customBaseUrl === 'string' && raw.customBaseUrl) {
    out.customBaseUrl = raw.customBaseUrl;
  }
  if (typeof raw.channelMode === 'string' && CHANNEL_MODES.includes(raw.channelMode)) {
    out.channelMode = raw.channelMode as Settings['channelMode'];
  }
  return out;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 保存设置，返回是否成功（配额满时降级为内存态） */
export function saveSettings(settings: Settings): boolean {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** 多标签同步：设置变更（主题等）以磁盘为准 */
export function onStorageChange(handler: () => void): () => void {
  const listener = (e: StorageEvent): void => {
    if (e.key === null || e.key === SETTINGS_KEY) {
      handler();
    }
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}
