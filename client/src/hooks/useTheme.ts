// 主题应用 —— settingsStore.theme → <html data-theme>，system 时监听系统偏好

import { useEffect, useState } from 'react';
import { applyResolvedTheme, resolveTheme, useSettingsStore } from '../stores/settingsStore';

/** 应用当前主题（含 system 监听），在 App 根部挂载一次 */
export function useTheme(): void {
  const theme = useSettingsStore((s) => s.settings.theme);
  useEffect(() => {
    applyResolvedTheme(theme);
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (): void => applyResolvedTheme(theme);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);
}

/** 响应式解析后的实际主题（dark/light），供 CodeMirror 等内容层使用 */
export function useResolvedTheme(): 'dark' | 'light' {
  const theme = useSettingsStore((s) => s.settings.theme);
  const [resolved, setResolved] = useState<'dark' | 'light'>(() => resolveTheme(theme));
  useEffect(() => {
    const update = (): void => setResolved(resolveTheme(theme));
    update();
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [theme]);
  return resolved;
}
