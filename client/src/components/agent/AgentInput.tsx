// AgentInput —— 任务输入区：Enter 发送 / Shift+Enter 换行；流式中切换为停止按钮
// 无 Key 不禁用（服务端会以 SSE error MISSING_API_KEY 回应），但给出视觉提示。

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface AgentInputProps {
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder?: string;
}

export function AgentInput({ onSend, onStop, streaming, disabled, placeholder }: AgentInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 高度自适应（最多 200px）
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const submit = (): void => {
    const text = value.trim();
    if (!text || streaming || disabled) return;
    onSend(text);
    setValue('');
  };

  return (
    <div className="shrink-0 border-t border-border p-2.5">
      <div
        className={cn(
          'flex items-end gap-2 rounded-md border bg-bg-primary p-1.5 transition-colors duration-150',
          streaming ? 'border-accent' : 'border-border focus-within:border-accent',
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          disabled={disabled}
          placeholder={placeholder ?? '描述任务，Enter 发送 / Shift+Enter 换行'}
          aria-label="任务输入"
          className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent px-1.5 py-1 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none disabled:opacity-50"
        />
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-danger-subtle text-danger transition-colors duration-150 hover:bg-danger hover:text-text-on-accent"
            aria-label="停止任务"
            title="停止任务"
          >
            <Square size={13} />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim() || disabled}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-accent text-text-on-accent transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="发送任务"
            title="发送任务"
          >
            <ArrowUp size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
