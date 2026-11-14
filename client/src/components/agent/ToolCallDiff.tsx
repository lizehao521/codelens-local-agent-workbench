/**
 * 变更 diff 展示：审批前（effect.diff）与执行后（result_review.diff）共用。
 *
 * 只做展示，不解析、不重算：服务端已经给出 unified diff 与增删行数。
 * 颜色只用于 +/-/@@ 三类行，避免把 diff 渲染成语法高亮器。
 */
import type { EffectPreview } from '../../types';

export function ToolCallDiff({ items }: { items: NonNullable<EffectPreview['diff']> }) {
  const clipped = items.slice(0, 4);
  return (
    <div className="mb-2 rounded border border-border-subtle bg-bg-secondary p-2">
      <div className="mb-1 flex items-center gap-2 text-xs text-text-secondary">
        <span className="font-medium">变更 diff</span>
        {items.length > clipped.length && (
          <span className="text-text-tertiary">仅显示前 {clipped.length} 个文件</span>
        )}
      </div>
      <div className="space-y-1.5">
        {clipped.map((item) => (
          <div key={item.path}>
            <div className="flex items-center gap-2 font-mono text-[11px] text-text-tertiary">
              <span className="min-w-0 flex-1 truncate">{item.path}</span>
              <span className="text-success">+{item.added}</span>
              <span className="text-danger">-{item.removed}</span>
            </div>
            <pre className="mt-0.5 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-tertiary p-1.5 font-mono text-[11px] leading-4">
              {item.preview.split('\n').map((line, index) => (
                <div
                  key={index}
                  className={
                    line.startsWith('+')
                      ? 'text-success'
                      : line.startsWith('-')
                        ? 'text-danger'
                        : line.startsWith('@@')
                          ? 'text-accent'
                          : 'text-text-secondary'
                  }
                >
                  {line || ' '}
                </div>
              ))}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
