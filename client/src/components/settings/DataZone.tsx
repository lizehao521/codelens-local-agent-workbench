// 设置分区 ⑤ —— 数据管理：导出会话 JSON（含工具调用审计）/ 清除本机数据
// 会话本体在服务端 SQLite（删除请用会话侧栏）；本区管「本浏览器」与「导出」

import { useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { useServerSessionStore } from '../../stores/serverSessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { getSessionDetail } from '../../services/api';
import { saveDeviceToken } from '../../lib/device-store';
import { cn } from '../../lib/cn';

export function DataZone() {
  const sessions = useServerSessionStore((s) => s.sessions);
  const deviceToken = useServerSessionStore((s) => s.deviceToken);
  const settings = useSettingsStore((s) => s.settings);
  const pushToast = useUiStore((s) => s.pushToast);
  const [exporting, setExporting] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const handleExport = async (): Promise<void> => {
    setExporting(true);
    try {
      const details = [];
      for (const session of sessions) {
        details.push(await getSessionDetail(session.id, deviceToken));
      }
      const blob = new Blob([JSON.stringify({ exportedAt: Date.now(), sessions: details }, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `codelens-sessions-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      pushToast({ message: `已导出 ${details.length} 个会话`, variant: 'success' });
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : '导出失败', variant: 'error' });
    } finally {
      setExporting(false);
    }
  };

  const handleClearLocal = (): void => {
    // 只清本浏览器数据：设置、设备标识、活动会话指针（服务端会话不受影响）
    localStorage.removeItem('codeagent.settings.v1');
    localStorage.removeItem('codelens.deviceToken.v2');
    localStorage.removeItem('codelens.activeSession.v2');
    saveDeviceToken('');
    pushToast({ message: '本机数据已清除，刷新后生效', variant: 'info' });
    setConfirmClear(false);
  };

  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-1.5 text-sm font-medium text-text-primary">导出</h3>
        <p className="mb-2 text-xs text-text-tertiary">
          导出全部会话（含消息与工具调用审计）为 JSON。共 {sessions.length} 个会话。
        </p>
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={exporting || sessions.length === 0}
          className={cn(
            'flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-primary',
            'transition-colors duration-150 hover:border-accent disabled:opacity-50',
          )}
        >
          <Download size={14} />
          {exporting ? '导出中…' : '导出会话 JSON'}
        </button>
      </section>

      <section>
        <h3 className="mb-1.5 text-sm font-medium text-text-primary">本机数据</h3>
        <div className="space-y-1 text-xs text-text-tertiary">
          <p>设置与 API Key：{settings.apiKey ? '已保存（仅本浏览器）' : '未保存'}</p>
          <p>设备标识：{deviceToken ? '已绑定（用于会话归属与恢复）' : '未绑定'}</p>
          <p className="mt-1.5">
            会话消息与工具记录保存在服务端。删除单个会话请使用左侧会话列表的删除按钮；
            下面的操作只清除本浏览器数据，不影响服务端会话。
          </p>
        </div>
        {confirmClear ? (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs text-danger">确认清除本机数据？（服务端会话保留）</span>
            <button
              type="button"
              onClick={handleClearLocal}
              className="rounded bg-danger px-2.5 py-1 text-xs font-medium text-text-on-accent transition-colors duration-150 hover:opacity-90"
            >
              确认清除
            </button>
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              className="rounded border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors duration-150 hover:border-accent"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            className="mt-2 flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors duration-150 hover:border-danger hover:text-danger"
          >
            <Trash2 size={14} />
            清除本机数据
          </button>
        )}
      </section>
    </div>
  );
}
