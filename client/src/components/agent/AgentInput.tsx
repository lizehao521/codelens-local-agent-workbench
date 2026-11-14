// AgentInput —— 任务输入区：Enter 发送 / Shift+Enter 换行；流式中切换为停止按钮
// 无 Key 不禁用（服务端会以 SSE error MISSING_API_KEY 回应），但给出视觉提示。

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { cn } from '../../lib/cn';
import { suggestNextStep } from '../../lib/next-step';
import { useServerSessionStore } from '../../stores/serverSessionStore';
import { useComposerStore } from '../../stores/composerStore';
import { ExecutionModeSelector } from './ExecutionModeSelector';

export interface AgentInputProps {
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder?: string;
}

export function AgentInput({ onSend, onStop, streaming, disabled, placeholder }: AgentInputProps) {
  const [value, setValue] = useState('');
  const [idle, setIdle] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messages = useServerSessionStore((s) => s.messages);
  const draft = useComposerStore((s) => s.draft);
  const suggestion = useMemo(() => (value.trim() ? '' : suggestNextStep(messages)), [messages, value]);
  const showHint = idle && !dismissed && !!suggestion && !value.trim() && !streaming && !disabled;

  // 高度自适应（最多 200px）
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  // 空闲 700ms 后才推荐，避免刚清空输入框就闪提示。
  useEffect(() => {
    if (value.trim() || streaming || disabled) {
      setIdle(false);
      return;
    }
    const timer = setTimeout(() => setIdle(true), 700);
    return () => clearTimeout(timer);
  }, [value, streaming, disabled]);

  useEffect(() => {
    setDismissed(false);
  }, [suggestion]);

  // 插件/推荐写入草稿：只填值，不发送。
  useEffect(() => {
    if (!draft) return;
    setValue(draft);
    useComposerStore.getState().setDraft('');
    textareaRef.current?.focus();
  }, [draft]);

  const submit = (): void => {
    const text = value.trim();
    if (!text || streaming || disabled) return;
    onSend(text);
    setValue('');
    setDismissed(false);
  };

  return (
    <div className="shrink-0 border-t border-border p-2.5">
      <ExecutionModeSelector disabled={streaming || disabled} />
      {showHint && (
        <button
          type="button"
          onClick={() => {
            setValue(suggestion);
            setDismissed(true);
            textareaRef.current?.focus();
          }}
          className="mb-1.5 flex w-full items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-left text-[11px] text-text-secondary transition-colors hover:border-accent hover:text-accent"
          aria-live="polite"
        >
          <span className="min-w-0 flex-1 truncate">下一步：{suggestion}</span>
          <kbd className="rounded border border-border px-1 font-mono text-[10px]">Tab</kbd>
          <span>/</span>
          <kbd className="rounded border border-border px-1 font-mono text-[10px]">→</kbd>
          <span className="shrink-0 text-text-tertiary">填入</span>
        </button>
      )}
      <div
        className={cn(
          'flex items-end gap-2 rounded-md border bg-bg-primary p-1.5 transition-colors duration-150',
          streaming ? 'border-accent' : 'border-border focus-within:border-accent',
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setDismissed(false);
          }}
          onKeyDown={(e) => {
            if (
              showHint &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              (e.key === 'Tab' || e.key === 'ArrowRight')
            ) {
              e.preventDefault();
              setValue(suggestion);
              setDismissed(true);
              return;
            }
            if (e.key === 'Escape' && showHint) {
              setDismissed(true);
              return;
            }
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
