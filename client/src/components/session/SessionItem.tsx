// 会话项 —— 标题 + 相对时间 + 消息数 + hover 删除(Trash2) + 选中态(accent-subtle 底 + 2px 左标)
// v2.0：数据源为服务端会话（ServerSession）

import { Trash2 } from 'lucide-react';
import type { ServerSession } from '../../types';
import { formatRelativeTime } from '../../lib/format';
import { cn } from '../../lib/cn';

interface SessionItemProps {
  session: ServerSession;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

export function SessionItem({ session, active, onSelect, onDelete }: SessionItemProps) {
  return (
    <li className="relative">
      {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden="true" />}
      <div
        className={cn(
          'group flex items-center gap-2 pr-1 transition-colors duration-150',
          active ? 'bg-accent-subtle' : 'hover:bg-bg-tertiary',
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 px-3 py-2 text-left"
          aria-current={active ? 'true' : undefined}
        >
          <span className="block truncate text-sm text-text-primary">{session.title}</span>
          <span className="mt-0.5 block text-xs text-text-tertiary">
            {formatRelativeTime(session.updatedAt)} · {session.messageCount} 条消息
            {session.degraded && ' · 已降级'}
          </span>
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="删除会话"
          aria-label={`删除会话：${session.title}`}
          className={cn(
            'mr-1 inline-flex shrink-0 items-center justify-center rounded-md text-text-tertiary',
            'transition-colors duration-150 hover:bg-danger-subtle hover:text-danger',
            'h-8 w-8 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:h-11 [@media(hover:none)]:w-11 [@media(hover:none)]:opacity-100',
          )}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </li>
  );
}
