// 设置弹层表单基元 —— Field（标签+提示）与 Dropdown（自定义下拉，不用原生 select）
// 从 SettingsModal.tsx 抽出以满足「单文件 ≤ 300 行」约束

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-text-primary">{label}</span>
      {children}
      {hint && <span className="text-xs text-text-tertiary">{hint}</span>}
    </label>
  );
}

export function Dropdown({
  value,
  options,
  onChange,
  placeholder = '未选择',
  disabled = false,
  hint,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** 禁用时不可展开；用于试用态锁定上游（切换需自带 Key）。 */
  disabled?: boolean;
  /** 禁用原因，显示在按钮下方（给用户下一步动作，而不是只有灰）。 */
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const currentLabel = options.find((o) => o.value === value)?.label ?? value;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => (disabled ? undefined : setOpen((v) => !v))}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled}
        disabled={disabled}
        className={cn(
          'flex w-full items-center justify-between rounded-md border border-border bg-bg-primary px-2.5 py-1.5 text-base text-text-primary transition-colors duration-150',
          disabled ? 'cursor-not-allowed opacity-60' : 'hover:border-accent',
        )}
      >
        <span className="truncate">{currentLabel || placeholder}</span>
        <ChevronDown
          size={14}
          className={cn('shrink-0 text-text-secondary transition-transform duration-150', open && 'rotate-180')}
        />
      </button>
      {disabled && hint && <span className="mt-1 block text-xs text-text-secondary">{hint}</span>}
      {open && !disabled && (
        <ul
          role="listbox"
          className="absolute left-0 top-full z-[var(--c-z-dropdown)] mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-bg-tertiary py-1 shadow-overlay"
        >
          {options.map((opt) => (
            <li key={opt.value}>
              <button
                type="button"
                role="option"
                aria-selected={opt.value === value}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center justify-between px-2.5 py-1.5 text-left text-base transition-colors duration-150 [@media(hover:none)]:py-3',
                  opt.value === value
                    ? 'bg-accent-subtle font-medium text-accent'
                    : 'text-text-primary hover:bg-bg-secondary',
                )}
              >
                {opt.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
