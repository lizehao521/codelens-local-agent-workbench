// 加载指示 —— Loader2 旋转 / 三点脉冲（design-tokens.css .dot-pulse）

import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cn('animate-spin text-text-secondary', className)} />;
}

/** 排队等待首 token 的三点脉冲（opacity 交错，CSS 动画见 design-tokens.css） */
export function DotPulse({ className }: { className?: string }) {
  return (
    <span className={cn('dot-pulse inline-flex items-center gap-1', className)} aria-label="等待响应">
      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
    </span>
  );
}
