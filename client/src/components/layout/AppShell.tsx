// AppShell（v2.0）—— 三栏组装（≥1024 三栏 / 768-1024 两栏+抽屉 / <768 单栏+TabBar）
// 左会话列表 | 中 Agent 工作台 | 右运行检视器；恢复码一次性弹窗；无 Key 引导条

import { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { AgentWorkbench } from '../agent/AgentWorkbench';
import { RunInspector } from '../agent/RunInspector';
import { RecoveryCodeModal } from '../agent/RecoveryCodeModal';
import { SettingsModal } from '../settings/SettingsModal';
import { TopBar } from './TopBar';
import { SessionSidebar } from './SessionSidebar';
import { StatusBar } from './StatusBar';
import { MobileTabBar } from './MobileTabBar';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { getTrialStatus, type TrialStatus } from '../../services/api';
import { fetchRelayLocalConfig } from '../../lib/relay';
import { cn } from '../../lib/cn';

/** 本地中转默认配置只自动套用一次，避免覆盖用户后续手动清空/修改的 Key。 */
const RELAY_BOOTSTRAP_KEY = 'codeagent.relay.bootstrap.v1';

export function AppShell() {
  const hasApiKey = useSettingsStore((s) => s.settings.apiKey.trim().length > 0);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const mobileTab = useUiStore((s) => s.mobileTab);
  const setMobileTab = useUiStore((s) => s.setMobileTab);
  const recoveryCode = useUiStore((s) => s.recoveryCode);
  const hideRecoveryCode = useUiStore((s) => s.hideRecoveryCode);
  const chatScrollNonce = useUiStore((s) => s.chatScrollNonce);

  // 全局快捷键：Esc 关抽屉；Ctrl/Cmd+K 新建会话（由侧栏处理，这里只做抽屉）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (settingsOpen) return;
      if (e.key === 'Escape' && sidebarOpen) setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setSidebarOpen, settingsOpen, sidebarOpen]);

  // 切到「工具」Tab 时无需特殊处理；切到「对话」时列表自行锚底
  useEffect(() => {
    if (mobileTab === 'chat') {
      // nonce 变化由列表内部 effect 消费；这里保持引用以触发依赖
      void chatScrollNonce;
    }
  }, [mobileTab, chatScrollNonce]);

  // 首次启动：从 .env.local（经 dev/preview 中间件）载入模型中转默认配置。
  // 静态部署下接口不存在 → 保持默认值，由设置页手动填写。
  useEffect(() => {
    let alive = true;
    try {
      if (localStorage.getItem(RELAY_BOOTSTRAP_KEY)) return;
    } catch {
      return;
    }
    void fetchRelayLocalConfig()
      .then((cfg) => {
        if (!alive || !cfg) return;
        const store = useSettingsStore.getState();
        // 用户已经自带 Key：不覆盖其配置，只记录已处理。
        if (store.settings.apiKey.trim()) {
          localStorage.setItem(RELAY_BOOTSTRAP_KEY, String(Date.now()));
          return;
        }
        store.update({
          provider: 'custom',
          customBaseUrl: cfg.baseUrl,
          model: cfg.model,
          ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        });
        localStorage.setItem(RELAY_BOOTSTRAP_KEY, String(Date.now()));
        useUiStore.getState().pushToast({
          message: `已载入本地中转配置（${cfg.model}）`,
          variant: 'success',
        });
      })
      .catch(() => {
        // 本地配置不可用不是致命错误：留在设置页手动配置即可，不打扰用户。
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg-primary text-text-primary">
      <TopBar />

      <div className="relative flex min-h-0 flex-1">
        {/* 桌面左栏：会话列表（≥1024） */}
        <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-bg-secondary lg:flex">
          <SessionSidebar />
        </aside>

        {/* 中栏：Agent 工作台（手机端仅 chat Tab 可见） */}
        <section className={cn('flex min-w-0 flex-1 flex-col', mobileTab !== 'chat' && 'max-md:hidden')}>
          {!hasApiKey && <NoKeyBanner onConfigure={() => setSettingsOpen(true)} />}
          <AgentWorkbench />
        </section>

        {/* 右栏：运行检视器（≥1024；手机端仅 tools Tab 可见） */}
        <section
          className={cn(
            'flex w-full shrink-0 flex-col border-l border-border bg-bg-secondary md:w-[300px] lg:w-[340px]',
            mobileTab !== 'tools' && 'max-md:hidden',
          )}
        >
          <RunInspector />
        </section>

        {/* 手机端「会话」Tab 内容 */}
        <section
          className={cn(
            'w-full flex-col bg-bg-secondary md:hidden',
            mobileTab === 'history' ? 'flex' : 'hidden',
          )}
        >
          <SessionSidebar onNavigate={() => setMobileTab('chat')} />
        </section>

        {/* 平板抽屉（768-1023） */}
        {sidebarOpen && (
          <>
            <div
              className="fixed inset-0 z-[var(--c-z-drawer)] bg-black/40 lg:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-hidden="true"
            />
            <aside className="fixed inset-y-0 left-0 z-[var(--c-z-drawer)] flex w-72 flex-col border-r border-border bg-bg-secondary shadow-drag md:flex lg:hidden">
              <SessionSidebar onNavigate={() => setSidebarOpen(false)} />
            </aside>
          </>
        )}
      </div>

      <StatusBar />
      <MobileTabBar />

      <SettingsModalLauncher />
      <RecoveryCodeModal
        open={recoveryCode !== null}
        recoveryCode={recoveryCode}
        onClose={hideRecoveryCode}
      />
    </div>
  );
}

/** 设置弹层（挂载顺序无关，直接渲染） */
function SettingsModalLauncher() {
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  return <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />;
}

/** 无 Key 引导条（A-02）：无 BYOK Key 时展示；试用模式开启时变成「试用转化条」。 */
function NoKeyBanner({ onConfigure }: { onConfigure: () => void }) {
  const [trial, setTrial] = useState<TrialStatus | null>(null);

  // 拉取试用状态（仅用于文案）；失败时回退到「未配置 API Key」，不阻断 UI。
  useEffect(() => {
    let alive = true;
    getTrialStatus()
      .then((status) => {
        if (alive) setTrial(status);
      })
      .catch(() => {
        if (alive) setTrial(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex shrink-0 items-center gap-2 bg-warning-subtle px-3 py-1.5 text-sm text-text-primary">
      <TriangleAlert size={16} className="shrink-0 text-warning" />
      <span className="min-w-0 flex-1 truncate">{trialBannerText(trial)}</span>
      <button
        type="button"
        onClick={onConfigure}
        className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-accent transition-colors duration-150 hover:bg-accent-subtle"
      >
        去配置
      </button>
    </div>
  );
}

/** 无 Key 引导条的转化文案（每个变体都保留「API Key」字样）。 */
function trialBannerText(trial: TrialStatus | null): string {
  if (trial?.enabled) {
    if (trial.budgetExceeded) return '今日试用额度已用完，请配置自己的 API Key';
    // 试用锁定上游：显式告诉用户「现在用的是谁」，避免用户以为可以随便换上游。
    const model = trial.trialUpstream?.model ? `（固定模型 ${trial.trialUpstream.model}）` : '';
    if (trial.remainingRuns === null) return `已启用免费试用${model}；配置自己的 API Key 可无限使用`;
    if (trial.remainingRuns > 0) {
      return `免费试用${model}：今日还可 ${trial.remainingRuns} 次；配置自己的 API Key 可无限使用`;
    }
    return '今日免费试用已用完，配置自己的 API Key 即可无限使用';
  }
  return '还未配置 API Key，前往设置填写后 Agent 才能调用模型';
}
