// SettingsModal（v2.0 五分区）—— ① 模型与密钥 ② 工具管理 ③ MCP 连接器 ④ 安全边界 ⑤ 数据管理
// spec §7：设置为模态；单文件 ≤300 行，各分区独立成件

import { useState } from 'react';
import { Modal } from '../common/Modal';
import { ProviderZone } from './ProviderZone';
import { ToolsZone } from './ToolsZone';
import { McpZone } from './McpZone';
import { SecurityZone } from './SecurityZone';
import { DataZone } from './DataZone';
import { cn } from '../../lib/cn';

type ZoneId = 'provider' | 'tools' | 'mcp' | 'security' | 'data';

const ZONES: { id: ZoneId; label: string }[] = [
  { id: 'provider', label: '模型与密钥' },
  { id: 'tools', label: '工具管理' },
  { id: 'mcp', label: 'MCP 连接器' },
  { id: 'security', label: '安全边界' },
  { id: 'data', label: '数据管理' },
];

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [zone, setZone] = useState<ZoneId>('provider');

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
          {zone === 'tools' && <ToolsZone />}
          {zone === 'mcp' && <McpZone />}
          {zone === 'security' && <SecurityZone />}
          {zone === 'data' && <DataZone />}
        </div>
      </div>
    </Modal>
  );
}
