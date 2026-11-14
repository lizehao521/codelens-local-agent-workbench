/** 插件注册表：内置 + 本地安装；状态持久化到 localStorage。 */
import { create } from 'zustand';
import { BUILTIN_PLUGINS } from './builtin';
import { validatePlugin, type UiPlugin } from './types';

const KEY = 'codelens.ui-plugins.v1';

interface Persisted {
  custom: UiPlugin[];
  enabled: Record<string, boolean>;
  activeId: string | null;
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { custom: [], enabled: {}, activeId: null };
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    const custom = Array.isArray(parsed.custom)
      ? parsed.custom.map((p) => validatePlugin(p)).filter((r): r is { ok: true; plugin: UiPlugin } => r.ok).map((r) => r.plugin)
      : [];
    return {
      custom,
      enabled: parsed.enabled && typeof parsed.enabled === 'object' ? parsed.enabled : {},
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
    };
  } catch {
    return { custom: [], enabled: {}, activeId: null };
  }
}

function persist(state: Persisted): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* 存储不可用不影响当前会话 */
  }
}

interface PluginState extends Persisted {
  install: (input: unknown) => { ok: boolean; error?: string };
  remove: (id: string) => void;
  toggle: (id: string) => void;
  setActive: (id: string) => void;
}

export const usePluginStore = create<PluginState>((set, get) => {
  const initial = load();
  return {
    ...initial,
    install: (input) => {
      const result = validatePlugin(input);
      if (!result.ok) return { ok: false, error: result.error };
      const exists = [...BUILTIN_PLUGINS, ...get().custom].some((p) => p.id === result.plugin.id);
      if (exists) return { ok: false, error: `插件 id 已存在：${result.plugin.id}` };
      const next: Persisted = {
        custom: [...get().custom, result.plugin],
        enabled: { ...get().enabled, [result.plugin.id]: true },
        activeId: result.plugin.id,
      };
      persist(next);
      set(next);
      return { ok: true };
    },
    remove: (id) => {
      const next: Persisted = {
        custom: get().custom.filter((p) => p.id !== id),
        enabled: get().enabled,
        activeId: get().activeId === id ? null : get().activeId,
      };
      persist(next);
      set({ custom: next.custom, activeId: next.activeId });
    },
    toggle: (id) => {
      const next: Persisted = {
        custom: get().custom,
        enabled: { ...get().enabled, [id]: get().enabled[id] === false },
        activeId: get().activeId,
      };
      persist(next);
      set({ enabled: next.enabled });
    },
    setActive: (activeId) => {
      persist({ custom: get().custom, enabled: get().enabled, activeId });
      set({ activeId });
    },
  };
});

/** 内置 + 自定义；enabled 缺省视为启用。 */
export function usePlugins(): Array<UiPlugin & { enabled: boolean }> {
  const custom = usePluginStore((s) => s.custom);
  const enabled = usePluginStore((s) => s.enabled);
  return [...BUILTIN_PLUGINS, ...custom].map((p) => ({ ...p, enabled: enabled[p.id] !== false }));
}
