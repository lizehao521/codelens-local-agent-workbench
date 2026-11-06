// RecoveryCodeModal —— 恢复码一次性展示（AC-05）：创建/重生成后弹出，只展示不存储
// 纪律：恢复码明文只出现这一次；关闭后前端不再持有，服务端只存加盐哈希。

import { useEffect, useState } from 'react';
import { Copy, KeyRound } from 'lucide-react';
import { Modal } from '../common/Modal';
import { copyToClipboard } from '../../lib/format';
import { useUiStore } from '../../stores/uiStore';

export interface RecoveryCodeModalProps {
  open: boolean;
  recoveryCode: string | null;
  onClose: () => void;
}

export function RecoveryCodeModal({ open, recoveryCode, onClose }: RecoveryCodeModalProps) {
  const pushToast = useUiStore((s) => s.pushToast);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) setCopied(false);
  }, [open, recoveryCode]);

  const handleCopy = async (): Promise<void> => {
    if (!recoveryCode) return;
    const ok = await copyToClipboard(recoveryCode);
    if (ok) {
      setCopied(true);
      pushToast({ message: '恢复码已复制', variant: 'success' });
    } else {
      pushToast({ message: '复制失败，请手动记录', variant: 'error' });
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="保存恢复码">
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded bg-warning-subtle p-2.5 text-xs text-text-primary">
          <KeyRound size={14} className="mt-0.5 shrink-0 text-warning" />
          <p>
            凭此恢复码可在其他浏览器恢复本会话（含全部消息与工具记录）。
            <strong className="mx-1 font-medium">只显示这一次</strong>
            ，关闭后无法再次查看；遗失需重新生成（旧码立即失效）。
          </p>
        </div>

        <div className="flex items-center gap-2">
          <code
            data-testid="recovery-code"
            className="flex-1 rounded border border-border bg-bg-primary px-3 py-2 text-center font-mono text-lg tracking-[0.3em] text-accent"
          >
            {recoveryCode ?? '--------'}
          </code>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="flex items-center gap-1 rounded border border-border px-2.5 py-2 text-xs text-text-secondary transition-colors duration-150 hover:border-accent hover:text-accent"
          >
            <Copy size={12} />
            {copied ? '已复制' : '复制'}
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full rounded bg-accent py-2 text-sm font-medium text-text-on-accent transition-colors duration-150 hover:bg-accent-hover"
        >
          我已保存
        </button>
      </div>
    </Modal>
  );
}
