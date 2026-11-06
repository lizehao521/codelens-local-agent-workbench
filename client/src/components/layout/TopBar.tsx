// 顶栏 48px —— Logo(Code2)+CodeLens、会话标题、主题循环切换(Moon/Sun/Monitor)、工具技能、设置(Settings)

import { useState } from 'react';
import { Boxes, Code2, History, Monitor, Moon, Settings, Sun } from 'lucide-react';
import type { ThemeMode } from '../../types';
import { useActiveServerSession } from '../../stores/serverSessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { IconButton } from '../common/IconButton';
import { ToolSkillModal } from './ToolSkillModal';

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
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const [toolSkillOpen, setToolSkillOpen] = useState(false);

  const cycleTheme = (): void => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    setTheme(next);
  };

  const ThemeIcon = THEME_META[theme].icon;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg-secondary px-3">
      {/* 平板（768-1023）：历史抽屉入口 */}
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

      <IconButton
        icon={<ThemeIcon size={20} />}
        label={`主题：${THEME_META[theme].label}（点击切换）`}
        alwaysVisible
        onClick={cycleTheme}
      />
      <IconButton
        icon={<Boxes size={20} />}
        label="工具技能"
        alwaysVisible
        onClick={() => setToolSkillOpen(true)}
      />
      <IconButton
        icon={<Settings size={20} />}
        label="设置"
        alwaysVisible
        onClick={() => setSettingsOpen(true)}
      />

      <ToolSkillModal open={toolSkillOpen} onClose={() => setToolSkillOpen(false)} />
    </header>
  );
}
