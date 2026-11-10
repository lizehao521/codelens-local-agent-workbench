// 会话侧栏（v2.0）—— 服务端会话列表：新建 / 搜索 / 选择 / 删除 / 恢复码恢复 / 重生成恢复码
// AC-05：跨浏览器恢复走 POST /sessions/recover；恢复码只明文一次（弹 RecoveryCodeModal）

import { useMemo, useState } from 'react';
import { KeyRound, MessageSquarePlus, RefreshCw, Search } from 'lucide-react';
import type { ServerSession } from '../../types';
import { useServerSessionStore } from '../../stores/serverSessionStore';
import { useToolCallStore } from '../../stores/toolCallStore';
import { useApprovalStore } from '../../stores/approvalStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { abortActiveRun } from '../../hooks/useAgentStream';
import { recoverSession, regenerateRecoveryCode } from '../../services/api';
import { SessionItem } from '../session/SessionItem';
import { Modal } from '../common/Modal';
import { cn } from '../../lib/cn';

interface SessionSidebarProps {
  /** 选择/新建后回调（抽屉与移动端用于关闭） */
  onNavigate?: () => void;
  className?: string;
}

export function SessionSidebar({ onNavigate, className }: SessionSidebarProps) {
  const sessions = useServerSessionStore((s) => s.sessions);
  const activeSessionId = useServerSessionStore((s) => s.activeSessionId);
  const listLoading = useServerSessionStore((s) => s.listLoading);
  const listError = useServerSessionStore((s) => s.lastError);
  const deviceToken = useServerSessionStore((s) => s.deviceToken);
  const loadList = useServerSessionStore((s) => s.loadList);
  const selectSession = useServerSessionStore((s) => s.selectSession);
  const createOnServer = useServerSessionStore((s) => s.createOnServer);
  const removeOnServer = useServerSessionStore((s) => s.removeOnServer);
  const resetToolCalls = useToolCallStore((s) => s.reset);
  const resetApprovals = useApprovalStore((s) => s.reset);
  const settings = useSettingsStore((s) => s.settings);
  const pushToast = useUiStore((s) => s.pushToast);
  const setMobileTab = useUiStore((s) => s.setMobileTab);
  const showRecoveryCode = useUiStore((s) => s.showRecoveryCode);
  const [query, setQuery] = useState('');
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [recoverInput, setRecoverInput] = useState('');
  const [recoverError, setRecoverError] = useState<string | null>(null);
  /** 待确认删除的会话（删除不可撤销，二次确认后才真正发请求） */
  const [pendingDelete, setPendingDelete] = useState<ServerSession | null>(null);

  const sorted = useMemo(() => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt), [sessions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((s) => s.title.toLowerCase().includes(q) || s.model.toLowerCase().includes(q));
  }, [sorted, query]);

  const handleCreate = async (): Promise<void> => {
    if (abortActiveRun()) {
      pushToast({ message: '已停止当前生成', variant: 'info' });
    }
    try {
      const created = await createOnServer({ provider: settings.provider, model: settings.model });
      showRecoveryCode(created.recoveryCode);
      resetToolCalls();
      resetApprovals();
      setMobileTab('chat');
      onNavigate?.();
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : '会话创建失败', variant: 'error' });
    }
  };

  const handleSelect = async (id: string): Promise<void> => {
    if (id !== activeSessionId && abortActiveRun()) {
      pushToast({ message: '已停止当前生成', variant: 'info' });
    }
    resetToolCalls();
    resetApprovals();
    await selectSession(id);
    setMobileTab('chat');
    onNavigate?.();
  };

  const handleDelete = async (id: string): Promise<void> => {
    // 删除正在运行的会话前先中止本地流，避免后续事件写入已删除会话
    if (id === activeSessionId && abortActiveRun()) {
      pushToast({ message: '已停止当前生成', variant: 'info' });
    }
    try {
      await removeOnServer(id);
      resetToolCalls();
      resetApprovals();
      pushToast({ message: '已删除会话', variant: 'info' });
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : '删除失败', variant: 'error' });
    }
  };

  const handleRegenerate = async (id: string): Promise<void> => {
    try {
      const data = await regenerateRecoveryCode(id);
      showRecoveryCode(data.recoveryCode);
      pushToast({ message: '旧恢复码已立即失效', variant: 'info' });
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : '重生成失败', variant: 'error' });
    }
  };

  const handleRecover = async (): Promise<void> => {
    const code = recoverInput.trim();
    if (!/^[A-Z2-9]{8}$/.test(code)) {
      setRecoverError('恢复码为 8 位，不含 0/O/1/I');
      return;
    }
    if (!deviceToken) {
      setRecoverError('本设备还没有设备标识，请先创建会话');
      return;
    }
    setRecoverError(null);
    try {
      const data = await recoverSession(code, deviceToken);
      resetToolCalls();
      resetApprovals();
      await loadList();
      await selectSession(data.session.id);
      setRecoverOpen(false);
      setRecoverInput('');
      pushToast({ message: '会话已恢复', variant: 'success' });
    } catch (err) {
      setRecoverError(err instanceof Error ? err.message : '恢复失败');
    }
  };

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="p-3 pb-2">
        <button
          type="button"
          onClick={() => void handleCreate()}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-md border border-border bg-bg-tertiary',
            'py-2 text-base font-medium text-text-primary transition-colors duration-150 hover:border-accent',
          )}
        >
          <MessageSquarePlus size={16} className="text-accent" />
          新建会话
        </button>

        <div className="relative mt-2">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话（标题 / 模型）"
            aria-label="搜索会话"
            className={cn(
              'w-full rounded-md border border-border bg-bg-primary py-1.5 pl-8 pr-2 text-sm text-text-primary',
              'placeholder:text-text-tertiary transition-colors duration-150 focus:border-accent',
            )}
          />
        </div>

        <button
          type="button"
          onClick={() => setRecoverOpen(true)}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-border py-1.5 text-xs text-text-secondary transition-colors duration-150 hover:border-accent hover:text-accent"
        >
          <KeyRound size={13} />
          输入恢复码恢复会话
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {listError && (
          <div role="alert" className="mx-3 mb-2 rounded-md border border-danger bg-danger-subtle px-2.5 py-2">
            <p className="break-words text-xs text-danger">会话加载失败：{listError}</p>
            <button
              type="button"
              onClick={() => void loadList()}
              disabled={listLoading}
              className="mt-1.5 inline-flex items-center gap-1 rounded border border-danger px-2 py-0.5 text-xs text-danger transition-colors duration-150 hover:bg-danger hover:text-bg-primary disabled:opacity-50"
            >
              <RefreshCw size={11} className={cn(listLoading && 'animate-spin')} />
              {listLoading ? '重试中…' : '重试'}
            </button>
          </div>
        )}

        {listLoading && sessions.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-text-secondary">加载中…</p>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-8 text-center">
            {sessions.length === 0 ? (
              <p className="text-sm text-text-secondary">
                {listError ? '暂时无法加载会话列表，请重试。' : '还没有会话，点击上方「新建会话」开始。'}
              </p>
            ) : (
              <p className="text-sm text-text-secondary">没有匹配「{query.trim()}」的会话。</p>
            )}
          </div>
        ) : (
          <ul className="flex flex-col pb-2">
            {filtered.map((s) => (
              <SessionItem
                key={s.id}
                session={s}
                active={s.id === activeSessionId}
                onSelect={() => void handleSelect(s.id)}
                onDelete={() => setPendingDelete(s)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* 当前会话的恢复码管理 */}
      {activeSessionId && (
        <div className="shrink-0 border-t border-border p-2">
          <button
            type="button"
            onClick={() => void handleRegenerate(activeSessionId)}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-xs text-text-tertiary transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary"
          >
            <RefreshCw size={12} />
            重生成当前会话恢复码
          </button>
        </div>
      )}

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="删除会话"
        maxWidth={420}
        footer={
          <>
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors duration-150 hover:border-accent hover:text-accent"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                const target = pendingDelete;
                setPendingDelete(null);
                if (target) void handleDelete(target.id);
              }}
              className="rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-text-on-accent transition-colors duration-150 hover:opacity-90"
            >
              删除
            </button>
          </>
        }
      >
        <p className="text-sm text-text-primary">
          将永久删除会话「{pendingDelete?.title ?? ''}」及其全部消息与工具记录。
        </p>
        <p className="mt-1.5 text-xs text-text-tertiary">此操作无法撤销。</p>
      </Modal>

      <Modal open={recoverOpen} onClose={() => setRecoverOpen(false)} title="恢复码恢复会话" maxWidth={420}>
        <div className="space-y-3">
          <p className="text-xs text-text-secondary">
            输入创建会话时保存的 8 位恢复码，即可在当前浏览器恢复该会话的全部消息与工具记录。
            恢复码使用一次后立即失效。
          </p>
          <input
            value={recoverInput}
            onChange={(e) => setRecoverInput(e.target.value.toUpperCase())}
            placeholder="8 位恢复码"
            maxLength={8}
            aria-label="恢复码"
            className="w-full rounded border border-border bg-bg-primary px-3 py-2 text-center font-mono text-lg tracking-[0.3em] text-text-primary focus:border-accent"
          />
          {recoverError && <p className="text-xs text-danger">{recoverError}</p>}
          <button
            type="button"
            onClick={() => void handleRecover()}
            className="w-full rounded bg-accent py-2 text-sm font-medium text-text-on-accent transition-colors duration-150 hover:bg-accent-hover"
          >
            恢复
          </button>
        </div>
      </Modal>
    </div>
  );
}
