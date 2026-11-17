// 右侧检视器（≥768）——「运行」与「能力」两页签。
// 运行页沿用 RunInspector；能力页把后端能力收成可点击入口，并给出检查点 / 轨迹的实时读数。
// 设计原则：这里是「观察 + 进入」，不复制各面板自己的编辑逻辑。

import { useState } from 'react';
import {
  Boxes,
  ClipboardList,
  Gauge,
  KeyRound,
  LineChart,
  Route,
  ShieldAlert,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { RunInspector } from '../agent/RunInspector';
import { PluginDock } from '../../plugins/PluginDock';
import { listCheckpoints, listTraces, type CheckpointSummary, type TraceSummary } from '../../services/api';
import { useAsyncData } from '../../hooks/useAsyncData';
import { useServerSessionStore } from '../../stores/serverSessionStore';
import { useUiStore, type CapabilityModal } from '../../stores/uiStore';
import { formatRelativeTime } from '../../lib/format';
import { cn } from '../../lib/cn';

type DockTab = 'run' | 'cap' | 'plugins';

const TABS: Array<{ id: DockTab; label: string }> = [
  { id: 'run', label: '运行检视器' },
  { id: 'cap', label: '能力' },
  { id: 'plugins', label: '插件' },
];

const CAPABILITY_ENTRIES: Array<{
  id: CapabilityModal;
  label: string;
  desc: string;
  icon: LucideIcon;
}> = [
  { id: 'judge', label: '判据塔', desc: '判决与自证', icon: Gauge },
  { id: 'rsi', label: 'RSI 曲线', desc: '通过率与代际', icon: LineChart },
  { id: 'iteration', label: '迭代闸门', desc: '去留决策', icon: ShieldCheck },
  { id: 'sandbox', label: '沙箱权限', desc: '目录与免审批', icon: ShieldAlert },
  { id: 'skills', label: '工具技能', desc: '工具 / 技能 / MCP', icon: Boxes },
];

export function RightDock({ className }: { className?: string }) {
  const [tab, setTab] = useState<DockTab>('run');

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-bg-secondary', className)}>
      <div
        role="tablist"
        aria-label="检视器视图"
        className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-2"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={cn(
              'rounded px-2 py-1 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              tab === item.id
                ? 'bg-accent-subtle font-medium text-accent'
                : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'run' ? <RunInspector /> : tab === 'cap' ? <CapabilityPanel /> : <PluginDock />}
      </div>
    </div>
  );
}

function CapabilityPanel() {
  const openCapability = useUiStore((s) => s.openCapability);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const sessionId = useServerSessionStore((s) => s.activeSessionId);

  return (
    <div className="h-full space-y-4 overflow-y-auto p-3">
      <section aria-label="治理能力">
        <SectionTitle icon={ShieldCheck} title="治理" />
        <div className="grid grid-cols-2 gap-2">
          {CAPABILITY_ENTRIES.map(({ id, label, desc, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => openCapability(id)}
              aria-haspopup="dialog"
              className="flex flex-col items-start gap-1 rounded-md border border-border bg-bg-primary p-2 text-left transition-colors duration-150 hover:border-accent hover:bg-accent-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Icon size={16} className="text-accent" />
              <span className="text-xs font-medium text-text-primary">{label}</span>
              <span className="text-xs text-text-tertiary">{desc}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-haspopup="dialog"
            className="flex flex-col items-start gap-1 rounded-md border border-border bg-bg-primary p-2 text-left transition-colors duration-150 hover:border-accent hover:bg-accent-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <KeyRound size={16} className="text-accent" />
            <span className="text-xs font-medium text-text-primary">模型与密钥</span>
            <span className="text-xs text-text-tertiary">Provider / BYOK</span>
          </button>
        </div>
      </section>

      <CheckpointsSection sessionId={sessionId} />
      <TracesSection />
    </div>
  );
}

function CheckpointsSection({ sessionId }: { sessionId: string | null }) {
  const setWorkspaceView = useUiStore((s) => s.setWorkspaceView);
  const { data, error, loading, reload } = useAsyncData(
    () => listCheckpoints(sessionId ?? undefined),
    [sessionId],
    { enabled: !!sessionId, errorMessage: '加载检查点失败' },
  );

  return (
    <section aria-label="检查点">
      <SectionTitle
        icon={ClipboardList}
        title="检查点"
        action={
          <button
            type="button"
            onClick={reload}
            className="text-xs text-text-tertiary transition-colors hover:text-accent"
          >
            刷新
          </button>
        }
      />
      {!sessionId ? (
        <p className="text-xs text-text-tertiary">选择会话后显示检查点。</p>
      ) : loading && !data ? (
        <p className="text-xs text-text-tertiary">加载中…</p>
      ) : error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : !data?.enabled ? (
        <p className="text-xs text-text-tertiary">检查点未开启（CHECKPOINT_ENABLED）。</p>
      ) : data.checkpoints.length === 0 ? (
        <p className="text-xs text-text-tertiary">本次会话还没有检查点。</p>
      ) : (
        <>
          <ul className="space-y-1">
            {data.checkpoints.slice(0, 5).map((cp: CheckpointSummary) => (
              <li key={cp.id} className="rounded border border-border px-2 py-1">
                <p className="truncate text-xs text-text-primary" title={cp.label}>
                  {cp.label}
                </p>
                <p className="text-xs text-text-tertiary">
                  {cp.fileCount} 个文件 · {formatRelativeTime(cp.createdAt)}
                </p>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setWorkspaceView('audit')}
            className="mt-1 text-xs text-accent transition-colors hover:text-accent-hover"
          >
            去审计台确认回滚 →
          </button>
        </>
      )}
    </section>
  );
}

function TracesSection() {
  const { data, error, loading } = useAsyncData(() => listTraces({ limit: 5 }), [], {
    errorMessage: '加载轨迹失败',
  });

  return (
    <section aria-label="运行轨迹">
      <SectionTitle icon={Route} title="运行轨迹" />
      {loading && !data ? (
        <p className="text-xs text-text-tertiary">加载中…</p>
      ) : error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : !data?.enabled ? (
        <p className="text-xs text-text-tertiary">轨迹未开启（TRACE_ENABLED）。</p>
      ) : data.traces.length === 0 ? (
        <p className="text-xs text-text-tertiary">还没有运行轨迹。</p>
      ) : (
        <ul className="space-y-1">
          {data.traces.map((trace: TraceSummary) => (
            <li key={trace.traceId} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="min-w-0 truncate text-text-primary" title={trace.rootName}>
                {trace.rootName}
              </span>
              <span className="shrink-0 text-text-tertiary">
                {trace.spanCount} 段 · {formatRelativeTime(trace.startedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SectionTitle({
  icon: Icon,
  title,
  action,
}: {
  icon: LucideIcon;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
        <Icon size={12} />
        {title}
      </h3>
      {action}
    </div>
  );
}
