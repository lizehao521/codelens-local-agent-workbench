// Toast 列表 —— z-toast，250ms 淡入（app.css .toast-in），2s 自动消失（计时在 uiStore）

import { CircleCheck, CircleX, Info } from 'lucide-react';
import type { ComponentType } from 'react';
import { useUiStore, type ToastVariant } from '../../stores/uiStore';
import { cn } from '../../lib/cn';

const VARIANT_CONFIG: Record<ToastVariant, { icon: ComponentType<{ size?: number; className?: string }>; className: string }> = {
  info: { icon: Info, className: 'text-text-secondary' },
  success: { icon: CircleCheck, className: 'text-success' },
  error: { icon: CircleX, className: 'text-danger' },
};

export function ToastContainer() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);

  return (
    <div
      className="pointer-events-none fixed left-1/2 top-16 z-[var(--c-z-toast)] flex -translate-x-1/2 flex-col items-center gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => {
        const { icon: Icon, className } = VARIANT_CONFIG[toast.variant];
        return (
          <div
            key={toast.id}
            className={cn(
              'toast-in pointer-events-auto flex cursor-pointer items-center gap-2 rounded-md',
              'border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary shadow-overlay',
            )}
            onClick={() => dismiss(toast.id)}
          >
            <Icon size={16} className={className} />
            <span>{toast.message}</span>
          </div>
        );
      })}
    </div>
  );
}
