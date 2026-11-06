// 手机底部 TabBar —— 对话(MessagesSquare) / 工具(Wrench) / 历史(History)，safe-area 适配
// v2.0 三 Tab（spec §7）：中栏对话 / 右栏检视器 / 左栏会话；流式期间「对话」显示 accent 圆点

import { History, MessagesSquare, Wrench } from 'lucide-react';
import type { MobileTab } from '../../stores/uiStore';
import { useRunStore } from '../../stores/runStore';
import { useUiStore } from '../../stores/uiStore';
import { cn } from '../../lib/cn';

const TABS: { id: MobileTab; label: string; icon: typeof History }[] = [
  { id: 'chat', label: '对话', icon: MessagesSquare },
  { id: 'tools', label: '工具', icon: Wrench },
  { id: 'history', label: '会话', icon: History },
];

export function MobileTabBar() {
  const mobileTab = useUiStore((s) => s.mobileTab);
  const setMobileTab = useUiStore((s) => s.setMobileTab);
  const streaming = useRunStore((s) => s.streaming);

  return (
    <nav
      aria-label="主导航"
      className="shrink-0 border-t border-border bg-bg-secondary pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="flex h-14 items-stretch">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = mobileTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setMobileTab(id)}
              aria-current={active ? 'page' : undefined}
              className="flex flex-1 flex-col items-center justify-center gap-0.5"
            >
              <span className="relative">
                <Icon size={24} className={active ? 'text-accent' : 'text-text-secondary'} strokeWidth={2} />
                {id === 'chat' && streaming && (
                  <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
                )}
              </span>
              <span
                className={cn(
                  'text-[10px] leading-none',
                  active ? 'font-medium text-accent' : 'text-text-secondary',
                )}
              >
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
