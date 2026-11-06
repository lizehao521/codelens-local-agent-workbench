// 工具类别 → Lucide 图标映射（规范名，16px，stroke-width 2）
// 兜底 Wrench —— 未知类别/未知名不会渲染成空白。

import type { LucideIcon } from 'lucide-react';
import {
  Braces,
  Calculator,
  Clock,
  FilePen,
  FileText,
  Fingerprint,
  FolderOpen,
  Globe,
  Plug,
  TextQuote,
  Wrench,
} from 'lucide-react';
import type { ToolCategory } from '../types';

/** file / compute 类别按工具名细分（点号规范名的末段） */
const NAME_ICON: Record<string, LucideIcon> = {
  'fs.read': FileText,
  'fs.write': FilePen,
  'fs.list': FolderOpen,
  'calc.evaluate': Calculator,
  'time.now': Clock,
  'uuid.generate': Fingerprint,
  'json.format': Braces,
  'text.diff': TextQuote,
};

export function categoryIcon(category: ToolCategory, name?: string): LucideIcon {
  if (name) {
    const exact = NAME_ICON[name];
    if (exact) return exact;
    const last = name.split('.').pop() ?? '';
    if (/^read/.test(last)) return FileText;
    if (/^write/.test(last)) return FilePen;
    if (/^list/.test(last)) return FolderOpen;
    if (/calc|eval|compute/.test(last)) return Calculator;
    if (/^time/.test(last)) return Clock;
    if (/uuid|random/.test(last)) return Fingerprint;
    if (/json/.test(last)) return Braces;
    if (/diff|text/.test(last)) return TextQuote;
  }
  switch (category) {
    case 'http':
      return Globe;
    case 'file':
      return FileText;
    case 'compute':
      return Calculator;
    case 'mcp':
      return Plug;
    default:
      return Wrench;
  }
}

/** 类别中文名（工具管理分组标题 / Inspector 详情用） */
export function categoryLabel(category: ToolCategory): string {
  switch (category) {
    case 'http':
      return 'HTTP 请求';
    case 'file':
      return '文件读写';
    case 'compute':
      return '计算与系统';
    case 'mcp':
      return 'MCP 提供的工具';
    default:
      return '其他工具';
  }
}

/** 设置页工具管理分组顺序（MCP 组在最后，只列已连接的） */
export const CATEGORY_ORDER: ToolCategory[] = ['http', 'file', 'compute', 'mcp'];
