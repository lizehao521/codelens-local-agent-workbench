// Markdown 渲染 —— react-markdown + remark-gfm + rehype-highlight（默认禁原始 HTML，XSS 防线）
// 围栏代码块走 CodeBlock（带语言标签 + 复制）；行内 code 渲染为等宽 chip

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { CodeBlock } from './CodeBlock';

interface MarkdownContentProps {
  content: string;
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <div className="markdown-body text-md leading-relaxed text-text-primary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // code 组件自行渲染 pre，避免 pre>pre 嵌套
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const match = /language-([\w-]+)/.exec(className ?? '');
            if (match) {
              return (
                <CodeBlock className={className} lang={match[1]}>
                  {children}
                </CodeBlock>
              );
            }
            return (
              <code className="rounded-sm bg-bg-tertiary px-1 py-0.5 font-mono text-code text-text-primary">
                {children}
              </code>
            );
          },
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
