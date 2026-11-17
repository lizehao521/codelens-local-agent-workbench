// 左侧能力导航（≥1024）——把「主视图切换」与「治理能力入口」从拥挤的中栏头部移出。
// 只负责打开：视图写 workspaceView，能力写 activeModal，实际挂载统一在 CapabilityHost。

import {
  Boxes,
  Gauge,
  History,
  LineChart,
  MessageSquare,
  Settings,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useUiStore, type CapabilityModal, type WorkspaceView } from '../../stores/uiStore';

const VIEWS: Array<{ id: WorkspaceView; label: string; icon: typeof MessageSquare }> = [
  { id: 'chat', label: '对话', icon: MessageSquare },
  { id: 'audit', label: '审计台', icon: History },
];

const CAPABILITIES: Array<{ id: CapabilityModal; label: string; icon: typeof Gauge; hint: string }> = [
  { id: 'judge', label: '判据塔', icon: Gauge, hint: '判决历史、自证状态与经验有效性' },
  { id: 'rsi', label: 'RSI', icon: LineChart, hint: '套件通过率、分母基线与代际曲线' },
  { id: 'iteration', label: '迭代', icon: ShieldCheck, hint: '逐轮量化判据、去留决策与人工处置' },
  { id: 'sandbox', label: '沙箱', icon: ShieldAlert, hint: '放开沙箱外目录与免审批' },
  { id: 'skills', label: '技能', icon: Boxes, hint: '工具、技能库、MCP 与运行时能力' },
];

export function SideRail() {
  const workspaceView = useUiStore((s) => s.workspaceView);
  const setWorkspaceView = useUiStore((s) => s.setWorkspaceView);
  const openCapability = useUiStore((s) => s.openCapability);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);

  return (
    <nav
      aria-label="能力导航"
      className="hidden w-[72px] shrink-0 flex-col items-center gap-0.5 border-r border-border bg-bg-secondary py-2 lg:flex"
    >
      {VIEWS.map(({ id, label, icon: Icon }) => {
        const active = workspaceView === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => setWorkspaceView(id)}
            aria-pressed={active}
            aria-current={active ? 'page' : undefined}
            title={label}
            className={cn(
              'flex h-14 w-16 flex-col items-center justify-center gap-1 rounded-md transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              active
                ? 'bg-accent-subtle text-accent'
                : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
            )}
          >
            <Icon size={20} strokeWidth={active ? 2.2 : 1.9} />
            <span className="whitespace-nowrap text-xs leading-none">{label}</span>
          </button>
        );
      })}

      <div className="my-1 h-px w-9 bg-border" aria-hidden="true" />
      <span className="sr-only">能力入口</span>

      {CAPABILITIES.map(({ id, label, icon: Icon, hint }) => (
        <button
          key={id}
          type="button"
          onClick={() => openCapability(id)}
          aria-haspopup="dialog"
          title={hint}
          className="flex h-14 w-16 flex-col items-center justify-center gap-1 rounded-md text-text-secondary transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Icon size={20} strokeWidth={1.9} />
          <span className="whitespace-nowrap text-xs leading-none">{label}</span>
        </button>
      ))}

      <div className="mt-auto" />

      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        aria-haspopup="dialog"
        title="设置"
        className="flex h-14 w-16 flex-col items-center justify-center gap-1 rounded-md text-text-secondary transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Settings size={20} strokeWidth={1.9} />
        <span className="whitespace-nowrap text-xs leading-none">设置</span>
      </button>
    </nav>
  );
}
