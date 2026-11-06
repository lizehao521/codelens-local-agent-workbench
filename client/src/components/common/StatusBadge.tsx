// 状态徽标 —— 统一「启用 / 未启用 / 不可用 / 失败」等状态标签的视觉。
//
// 此前这类小标签在 ToolSkillModal、ToolsZone、McpZone、JudgePanelModal 等处
// 各写一遍 className 串（`rounded bg-success-subtle px-1.5 py-0.5 text-xs
// text-success` 及其灰/红变体），共 4 处重复。徽标一旦要调整圆角或字号，
// 就是一次四处搜索替换 —— 抽成组件后只改一处。

export type StatusBadgeTone = 'success' | 'muted' | 'danger' | 'accent';

const TONE_CLASS: Record<StatusBadgeTone, string> = {
  success: 'bg-success-subtle text-success',
  muted: 'bg-bg-inset text-text-tertiary',
  danger: 'bg-danger-subtle text-danger',
  accent: 'bg-accent-subtle text-accent',
};

export function StatusBadge({
  tone,
  children,
  className = '',
}: {
  tone: StatusBadgeTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${TONE_CLASS[tone]} ${className}`.trim()}
    >
      {children}
    </span>
  );
}
