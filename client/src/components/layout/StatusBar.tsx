// 状态栏 28px —— 连接状态点 + provider·model + 运行态 + 消息数 + 跳到最新

import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { useServerSessionStore } from '../../stores/serverSessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useRunStore } from '../../stores/runStore';
import { useUiStore } from '../../stores/uiStore';
import { getHealth } from '../../services/api';
import { cn } from '../../lib/cn';

export function StatusBar() {
  const messages = useServerSessionStore((s) => s.messages);
  const settings = useSettingsStore((s) => s.settings);
  const streaming = useRunStore((s) => s.streaming);
  const requestChatScroll = useUiStore((s) => s.requestChatScroll);
  const [connected, setConnected] = useState<boolean | null>(null);

  // 挂载时做真实健康检查（spec §5 /api/health，含 db/mcp/sandbox）；
  // 周期复检：后端比前端晚启动、或中途重启时，状态点能自行恢复而不是一直停在「未连接」。
  useEffect(() => {
    let cancelled = false;
    const check = (): void => {
      void getHealth()
        .then((ok) => !cancelled && setConnected(ok.status === 'ok' && ok.db.ok))
        .catch(() => !cancelled && setConnected(false));
    };
    check();
    const timer = setInterval(check, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-bg-secondary px-3 text-xs text-text-secondary max-md:hidden">
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            connected === null ? 'bg-text-tertiary' : connected ? 'bg-success' : 'bg-danger',
          )}
          aria-hidden="true"
        />
        {connected === null ? '连接中…' : connected ? '已连接' : '未连接'}
      </span>

      <span className="font-mono">
        {settings.provider} · {settings.model || '未选择模型'}
      </span>

      {streaming && <span className="text-accent">运行中…</span>}

      <span className="ml-auto flex items-center gap-3">
        <span>本会话 {messages.length} 条消息</span>
        <button
          type="button"
          onClick={() => requestChatScroll()}
          title="跳到最新"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary"
        >
          <ArrowUp size={12} />
          跳到最新
        </button>
      </span>
    </footer>
  );
}
