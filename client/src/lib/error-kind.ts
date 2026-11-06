// 错误区查表 —— 主索引用 error.kind（不是 error.code）
// code 只是 mono 展示串，会随架构演进；kind 才是分类键。未知 kind 走兜底分支，绝不崩。

import type { ToolCallError, ToolErrorKind } from '../types';

/** 语义档位（映射到既有 Token 类名，不写裸色值） */
export type Semantic = 'danger' | 'warning' | 'neutral';

/** 恢复动作标识（由 ToolErrorBlock 渲染成按钮，业务规则不进 JSX） */
export type ErrorActionId =
  | 'retry'
  | 'view-args'
  | 'view-tools'
  | 'authorize'
  | 'allowlist'
  | 'fs-root'
  | 'reconnect'
  | 'view-stack'
  | 'view-head';

export interface ErrorKindConfig {
  label: string;
  semantic: Semantic;
  /** 是否可重试（决定 [重试] 按钮是否渲染） */
  retryable: boolean;
  actions: ErrorActionId[];
  /** 上下文行模板，{xxx} 占位由调用方按 error / call 填充；无则省略第 3 层 */
  contextTemplate?: string;
  /** 安全拦截类：不给绕行建议 */
  securityBlocked?: boolean;
}

const TABLE: Record<ToolErrorKind, ErrorKindConfig> = {
  timeout: {
    label: '超时',
    semantic: 'warning',
    retryable: true,
    actions: ['retry'],
    contextTemplate: '{tool} 已连续失败 {n} 次',
  },
  rate_limit: {
    label: '限流',
    semantic: 'warning',
    retryable: true,
    actions: ['retry'],
    contextTemplate: '已触发调用频率限制',
  },
  invalid_args: {
    label: '参数非法',
    semantic: 'danger',
    retryable: false,
    actions: ['view-args'],
    contextTemplate: '{field} 校验未通过',
  },
  not_found: {
    label: '目标不存在',
    semantic: 'danger',
    retryable: true,
    actions: ['view-tools', 'retry'],
    contextTemplate: '找不到 {target}',
  },
  security: {
    label: '权限拒绝',
    semantic: 'danger',
    retryable: false,
    actions: ['authorize', 'allowlist', 'fs-root'],
    contextTemplate: '{tool} 未获得执行授权 · 同一目标本任务内不再重试',
    securityBlocked: true,
  },
  network: {
    label: '网络错误',
    semantic: 'danger',
    retryable: true,
    actions: ['retry'],
    contextTemplate: '无法连接到 {host}',
  },
  upstream: {
    label: '上游服务错误',
    semantic: 'danger',
    retryable: true,
    actions: ['retry'],
    contextTemplate: '{tool} 的上游返回了错误响应',
  },
  mcp: {
    label: 'MCP 调用失败',
    semantic: 'danger',
    retryable: true,
    actions: ['reconnect'],
    contextTemplate: 'MCP 服务器 {server} 未连接，重连后可用',
  },
  circuit_open: {
    label: '工具已熔断',
    semantic: 'neutral',
    retryable: false,
    actions: ['view-tools'],
    contextTemplate: '{tool} 连续失败已达上限，本次任务内不再调用',
  },
  internal: {
    label: '内部错误',
    semantic: 'danger',
    retryable: true,
    actions: ['retry', 'view-stack'],
    contextTemplate: '{tool} 内部异常',
  },
};

/** 兜底：未知 kind（架构新增错误码时前端不崩） */
export const FALLBACK_CONFIG: ErrorKindConfig = {
  label: '执行失败',
  semantic: 'danger',
  retryable: true,
  actions: ['retry'],
};

/** 按 kind 查表；未知 / 缺失一律走兜底 */
export function configForKind(kind: string | undefined): ErrorKindConfig {
  if (!kind) return FALLBACK_CONFIG;
  return TABLE[kind as ToolErrorKind] ?? FALLBACK_CONFIG;
}

/** 语义色 → 既有 Token 类名（禁裸色值） */
export function semanticText(semantic: Semantic): string {
  if (semantic === 'warning') return 'text-warning';
  if (semantic === 'danger') return 'text-danger';
  return 'text-text-secondary';
}

export function semanticBg(semantic: Semantic): string {
  if (semantic === 'warning') return 'bg-warning-subtle';
  if (semantic === 'danger') return 'bg-danger-subtle';
  return 'bg-bg-tertiary';
}

export function semanticBadge(semantic: Semantic): string {
  if (semantic === 'warning') return 'bg-warning-subtle text-warning';
  if (semantic === 'danger') return 'bg-danger-subtle text-danger';
  return 'bg-bg-tertiary text-text-secondary';
}

/**
 * 按 code 细分 security 类的恢复动作（不给通用绕行建议）：
 * TOOL_DISABLED → 去工具设置授权；SSRF_BLOCKED → 加入白名单；PATH_JAIL_VIOLATION → 调整文件根目录。
 */
export function securityActions(code: string | undefined): ErrorActionId[] {
  switch (code) {
    case 'TOOL_DISABLED':
      return ['authorize'];
    case 'SSRF_BLOCKED':
      return ['allowlist'];
    case 'PATH_JAIL_VIOLATION':
      return ['fs-root'];
    default:
      return ['authorize'];
  }
}

/** 组装错误区的完整视图数据（第 1–5 层），业务规则全部留在本文件 */
export interface ErrorBlockVM {
  label: string;
  semantic: Semantic;
  code: string;
  message: string;
  context: string | null;
  suggestion: string | null;
  actions: ErrorActionId[];
  securityBlocked: boolean;
}

export function buildErrorBlock(error: ToolCallError, toolName: string): ErrorBlockVM {
  const config = configForKind(error.kind);
  const actions =
    config.securityBlocked && error.kind === 'security' ? securityActions(error.code) : config.actions;
  return {
    label: config.label,
    semantic: config.semantic,
    code: error.code,
    message: error.message,
    context: fillContext(config.contextTemplate, error, toolName),
    suggestion: error.suggestion?.trim() ? error.suggestion.trim() : null,
    actions,
    securityBlocked: config.securityBlocked === true,
  };
}

function fillContext(
  template: string | undefined,
  error: ToolCallError,
  toolName: string,
): string | null {
  if (!template) return null;
  return template
    .replace(/\{tool\}/g, toolName)
    .replace(/\{server\}/g, toolName.split('.')[0] || toolName)
    .replace(/\{field\}/g, error.code.replace(/[^A-Za-z0-9_.]/g, '') || '参数')
    .replace(/\{target\}/g, toolName)
    .replace(/\{host\}/g, '目标主机')
    .replace(/\{n\}/g, '1');
}
