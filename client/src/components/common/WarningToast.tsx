// WarningToast —— SSE warning 事件的 Toast 组件
// 支持同时显示最多 5 条，自动消失 5s，悬停暂停

import { CircleAlert, X, TriangleAlert } from 'lucide-react';
import { useWarningStore } from '../../stores/warningStore';
import { cn } from '../../lib/cn';
import { useEffect, useState } from 'react';

const VARIANT_CONFIG = {
  warning: {
    icon: TriangleAlert,
    className: 'text-warning',
    bgClass: 'bg-warning/10 border-warning/30',
  },
  error: {
    icon: CircleAlert,
    className: 'text-danger',
    bgClass: 'bg-danger/10 border-danger/30',
  },
};

interface WarningToastItemProps {
  warning: {
    id: string;
    message: string;
    variant: 'warning' | 'error';
    timestamp: number;
  };
  onDismiss: (id: string) => void;
}

function WarningToastItem({ warning, onDismiss }: WarningToastItemProps) {
  const [, setIsHovered] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const { icon: _Icon } = VARIANT_CONFIG[warning.variant];

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(false);
      setTimeout(() => onDismiss(warning.id), 300);
    }, 5000);

    return () => clearTimeout(timer);
  }, [warning.id, onDismiss]);

  if (!isVisible) return null;

  return (
    <div
      className={cn(
        'toast-in pointer-events-auto flex cursor-pointer items-start gap-2.5 rounded-md',
        'border bg-bg-tertiary px-3 py-2.5 text-sm text-text-primary shadow-overlay',
        'transition-all duration-300 ease-out',
        'hover:shadow-lg',
        'max-w-[380px] min-w-[280px]',
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => onDismiss(warning.id)}
      role="alert"
      aria-live="polite"
    >
      <div className="flex-shrink-0 mt-0.5">
        {warning.variant === 'warning' ? (
          <TriangleAlert size={16} className="text-warning" />
        ) : (
          <CircleAlert size={16} className="text-danger" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-text-primary break-words">{warning.message}</p>
        <p className="text-[10px] text-text-tertiary mt-1">
          {new Date(warning.timestamp).toLocaleTimeString()}
        </p>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDismiss(warning.id);
        }}
        className={cn(
          'flex-shrink-0 p-1 rounded hover:bg-bg-secondary transition-colors',
          'text-text-tertiary hover:text-text-primary',
        )}
        aria-label="关闭"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function WarningToastContainer() {
  const warnings = useWarningStore((s) => s.warnings);

  const visibleWarnings = warnings.slice(-5).reverse();

  if (visibleWarnings.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[var(--c-z-toast)] flex flex-col-reverse gap-2"
      role="status"
      aria-live="polite"
    >
      {visibleWarnings.map((warning) => (
        <WarningToastItem
          key={warning.id}
          warning={warning}
          onDismiss={useWarningStore.getState().removeWarning}
        />
      ))}
    </div>
  );
}
