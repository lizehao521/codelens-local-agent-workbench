// 代码块 —— mono 渲染 + 语言标签 + Copy（150ms 切 Check + 1.5s 恢复 + Toast）
// 两种内容来源：markdown 路径传已高亮 children；纯文本路径传 code

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyToClipboard } from '../../lib/format';
import { useUiStore } from '../../stores/uiStore';
import { cn } from '../../lib/cn';

/** 从已高亮的 React 节点树中提取纯文本（用于复制，天然去掉行号装饰） */
function extractText(node: ReactNode): string {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return extractText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

interface CodeBlockProps {
  /** 已高亮的渲染节点（markdown 路径） */
  children?: ReactNode;
  /** 纯文本代码（非 markdown 路径） */
  code?: string;
  /** 语言标识（展示标签；空串显示 code） */
  lang?: string;
  /** markdown 路径透传的 hljs class */
  className?: string;
}

export function CodeBlock({ children, code, lang, className }: CodeBlockProps) {
  const rawText = code ?? extractText(children);
  const [copied, setCopied] = useState(false);
  const pushToast = useUiStore((s) => s.pushToast);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(rawText);
    if (ok) {
      setCopied(true);
      pushToast({ message: '已复制', variant: 'success' });
    } else {
      pushToast({ message: '复制失败，请手动选择复制', variant: 'error' });
    }
  }, [rawText, pushToast]);

  return (
    <figure className="group/code my-2 overflow-hidden rounded-md border border-border bg-bg-secondary">
      <figcaption className="flex h-7 items-center justify-between border-b border-border-subtle px-2">
        <span className="font-mono text-xs uppercase tracking-caps text-text-tertiary">
          {lang || 'code'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          title="复制代码"
          aria-label="复制代码"
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded-sm text-text-secondary transition-colors duration-150',
            'hover:bg-bg-tertiary hover:text-text-primary',
            'opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:h-11 [@media(hover:none)]:w-11 [@media(hover:none)]:opacity-100',
          )}
        >
          {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        </button>
      </figcaption>
      <pre className="overflow-x-auto px-3 py-2">
        <code className={cn('hljs font-mono text-code leading-[1.6]', className)}>
          {children ?? code}
        </code>
      </pre>
    </figure>
  );
}

/** 导出供 DiffView 等复用 */
export { extractText };
