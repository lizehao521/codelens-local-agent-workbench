// 设置分区 ② —— 工具管理：按风险分组（low/medium/high）+ 分类分组 + 启停开关
// 数据源 GET /api/v1/tools（双轨名、按风险 grouped）；启停 PATCH /api/v1/tools/:name

import { useCallback, useEffect, useState } from 'react';
import { Loader } from 'lucide-react';
import type { RiskLevel, ToolCategory, ToolDefinitionPublic } from '../../types';
import { listTools, patchTool } from '../../services/api';
import { categoryIcon, categoryLabel } from '../../lib/tool-category';
import { useUiStore } from '../../stores/uiStore';
import { cn } from '../../lib/cn';

const RISK_LABEL: Record<RiskLevel, string> = { low: '低风险', medium: '中风险', high: '高风险' };
const RISK_CLASS: Record<RiskLevel, string> = {
  low: 'bg-success-subtle text-success',
  medium: 'bg-warning-subtle text-warning',
  high: 'bg-danger-subtle text-danger',
};

export function ToolsZone() {
  const [tools, setTools] = useState<ToolDefinitionPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const pushToast = useUiStore((s) => s.pushToast);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const data = await listTools();
      setTools(data.tools);
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : '工具列表加载失败', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggle = async (tool: ToolDefinitionPublic, enabled: boolean): Promise<void> => {
    setPending(tool.name);
    // 乐观更新
    setTools((prev) => prev.map((t) => (t.name === tool.name ? { ...t, enabled } : t)));
    try {
      await patchTool(tool.name, enabled);
    } catch (err) {
      setTools((prev) => prev.map((t) => (t.name === tool.name ? { ...t, enabled: !enabled } : t)));
      pushToast({ message: err instanceof Error ? err.message : '启停失败', variant: 'error' });
    } finally {
      setPending(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-text-secondary">
        <Loader size={14} className="animate-spin" /> 加载工具注册表…
      </div>
    );
  }

  const byCategory = new Map<ToolCategory, ToolDefinitionPublic[]>();
  for (const tool of tools) {
    const list = byCategory.get(tool.category) ?? [];
    list.push(tool);
    byCategory.set(tool.category, list);
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-text-tertiary">
        共 {tools.length} 个工具。禁用的工具不会下发给模型（模型完全不可见）；高危工具的调用仍需 inline 确认。
      </p>
      {[...byCategory.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([category, list]) => (
          <section key={category}>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-text-primary">
              {categoryLabel(category)}
              <span className="text-xs font-normal text-text-tertiary">{list.length}</span>
            </h3>
            <ul className="space-y-1">
              {list.map((tool) => {
                const Icon = categoryIcon(tool.category, tool.name);
                const enabled = tool.enabled !== false;
                return (
                  <li
                    key={tool.name}
                    className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-primary px-2.5 py-2"
                  >
                    <Icon size={14} className="shrink-0 text-text-secondary" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-text-primary">
                        {tool.displayName}
                        <span className="ml-1.5 font-mono text-xs text-text-tertiary">{tool.name}</span>
                      </p>
                      <p className="truncate text-xs text-text-tertiary" title={tool.description}>
                        {tool.description ?? '—'}
                      </p>
                    </div>
                    <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-xs', RISK_CLASS[tool.risk])}>
                      {RISK_LABEL[tool.risk]}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={`${enabled ? '禁用' : '启用'} ${tool.name}`}
                      disabled={pending === tool.name}
                      onClick={() => void handleToggle(tool, !enabled)}
                      className={cn(
                        'relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 disabled:opacity-50',
                        enabled ? 'bg-accent' : 'bg-bg-inset',
                      )}
                    >
                      <span
                        className={cn(
                          'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all duration-150',
                          enabled ? 'left-4.5' : 'left-0.5',
                        )}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
    </div>
  );
}
