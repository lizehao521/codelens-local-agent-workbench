// 顶栏 48px —— 品牌 + 会话标题 + 模型胶囊 + 主题 + 设置。
// 工具技能等治理入口已移到左侧能力导航 / 右栏「能力」页，顶栏不再堆按钮。

import { Code2, History, Monitor, Moon, Settings, Sun } from 'lucide-react';
import type { ThemeMode } from '../../types';
import { useActiveServerSession } from '../../stores/serverSessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { IconButton } from '../common/IconButton';

const THEME_ORDER: ThemeMode[] = ['system', 'dark', 'light'];
const THEME_META: Record<ThemeMode, { icon: typeof Moon; label: string }> = {
  system: { icon: Monitor, label: '跟随系统' },
  dark: { icon: Moon, label: '深色' },
  light: { icon: Sun, label: '浅色' },
};

export function TopBar() {
  const session = useActiveServerSession();
  const theme = useSettingsStore((s) => s.settings.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const provider = useSettingsStore((s) => s.settings.provider);
  const model = useSettingsStore((s) => s.settings.model);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);

  const cycleTheme = (): void => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    setTheme(next);
  };

  const ThemeIcon = THEME_META[theme].icon;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg-secondary px-3">
      {/* 平板（768-1023）：左栏隐藏，用抽屉打开会话列表 */}
      <IconButton
        icon={<History size={20} />}
        label="历史会话"
        alwaysVisible
        className="hidden md:inline-flex lg:hidden"
        onClick={() => setSidebarOpen(true)}
      />

      <div className="flex items-center gap-2">
        <Code2 size={20} className="text-accent" />
        <span className="text-base font-semibold tracking-tight text-text-primary">CodeLens</span>
      </div>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      <h1 className="min-w-0 flex-1 truncate text-sm text-text-secondary" title={session?.title}>
        {session?.title ?? '新会话'}
      </h1>

      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        title={`当前上游：${provider} / ${model || '未选择模型'}（点击切换）`}
        className="hidden max-w-[220px] items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-text-secondary transition-colors duration-150 hover:border-accent hover:text-accent sm:flex"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
        <span className="truncate">{model || '选择模型'}</span>
      </button>

      <IconButton
        icon={<ThemeIcon size={20} />}
        label={`主题：${THEME_META[theme].label}（点击切换）`}
        alwaysVisible
        onClick={cycleTheme}
      />
      <IconButton
        icon={<Settings size={20} />}
        label="设置"
        alwaysVisible
        onClick={() => setSettingsOpen(true)}
      />
    </header>
  );
}
