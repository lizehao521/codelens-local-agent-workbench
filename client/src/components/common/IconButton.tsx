// 图标按钮 —— 16/20/24 三档 + tooltip（title）+ 统一 hover/focus 表现

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

type IconSize = 16 | 20 | 24;

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 图标元素（lucide-react 组件，尺寸由 size 控制） */
  icon: ReactNode;
  size?: IconSize;
  /** tooltip 文案（同时作为无障碍名称） */
  label: string;
  variant?: 'ghost' | 'danger';
  /** 是否常驻可见（默认 hover 显现，触屏场景传 true） */
  alwaysVisible?: boolean;
}

export function IconButton({
  icon,
  size = 20,
  label,
  variant = 'ghost',
  alwaysVisible = false,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex items-center justify-center rounded-md text-text-secondary transition-colors duration-150',
        size === 16 ? 'h-7 w-7' : size === 20 ? 'h-9 w-9' : 'h-11 w-11',
        variant === 'danger'
          ? 'hover:bg-danger-subtle hover:text-danger'
          : 'hover:bg-bg-tertiary hover:text-text-primary',
        alwaysVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        'disabled:pointer-events-none disabled:opacity-30',
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
}
