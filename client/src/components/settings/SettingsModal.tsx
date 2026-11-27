// SettingsModal（v2.0 六分区）—— ① 模型与密钥 ② 模型市场 ③ 工具管理 ④ MCP 连接器 ⑤ 安全边界 ⑥ 数据管理 ⑦ UI 插件
// spec §7：设置为模态；单文件 ≤300 行，各分区独立成件

import { useState, useEffect } from 'react';
import { Modal } from '../common/Modal';
import { ProviderZone } from './ProviderZone';
import { ModelMarket } from './ModelMarket';
import { ToolsZone } from './ToolsZone';
import { McpZone } from './McpZone';
import { SecurityZone } from './SecurityZone';
import { DataZone } from './DataZone';
import { PluginsZone } from './PluginsZone';
import { cn } from '../../lib/cn';

type ZoneId = 'provider' | 'modelMarket' | 'tools' | 'mcp' | 'security' | 'data' | 'plugins';

const ZONES: { id: ZoneId; label: string }[] = [
  { id: 'provider', label: '模型与密钥' },
  { id: 'modelMarket', label: '模型市场' },
  { id: 'tools', label: '工具管理' },
  { id: 'mcp', label: 'MCP 连接器' },
  { id: 'plugins', label: 'UI 插件' },
  { id: 'security', label: '安全边界' },
  { id: 'data', label: '数据管理' },
];

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [zone, setZone] = useState<ZoneId>('provider');

  // 监听打开模型市场的自定义事件
  useEffect(() => {
    const handler = () => setZone('modelMarket');
    window.addEventListener('open-model-market', handler);
    return () => window.removeEventListener('open-model-market', handler);
  }, []);

  return (
    <Modal open={open} onClose={onClose} title="设置" maxWidth={760}>
      <div className="flex min-h-0 gap-4">
        {/* 左侧分区导航 */}
        <nav className="w-32 shrink-0 space-y-0.5" aria-label="设置分区">
          {ZONES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setZone(item.id)}
              aria-current={zone === item.id ? 'true' : undefined}
              className={cn(
                'w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-150',
                zone === item.id
                  ? 'bg-accent-subtle font-medium text-accent'
                  : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {/* 右侧分区内容 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {zone === 'provider' && <ProviderZone />}
          {zone === 'modelMarket' && <ModelMarket />}
          {zone === 'tools' && <ToolsZone />}
          {zone === 'mcp' && <McpZone />}
          {zone === 'security' && <SecurityZone />}
          {zone === 'data' && <DataZone />}
          {zone === 'plugins' && <PluginsZone />}
        </div>
      </div>
    </Modal>
  );
}
