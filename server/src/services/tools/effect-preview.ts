/**
 * 后果预览：审批主视图只说「会发生什么」，不展示命令原文。
 *
 * 判定口径（与总纲一致）：
 * - 可逆：新建 / 追加 / 重命名 / 覆盖（有写前快照时可恢复）—— 默认放行，事后审结果。
 * - 不可逆：delete / purge / sys.exec / http 写方法 —— 前置审批，展示影响面。
 *
 * 这里只读文件系统的事实（存在性、字节数、目录条目数），不推断模型意图。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { EffectItem, EffectPreview, ToolDefinition, ToolApprovalMode, RiskVerdict } from '../../types/tool.js';
import { resolveInSandbox } from '../../tools/builtin/path-jail.js';

export interface EffectContext {
  sandboxRoot: string;
  allowedDirs?: string[];
  /** 写前快照是否启用：决定 overwrite 是否可恢复。 */
  checkpointEnabled?: boolean;
}

const HTTP_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FS_IRREVERSIBLE = new Set(['delete', 'purge']);

function fileItem(absPath: string, displayPath: string): EffectItem {
  try {
    const st = statSync(absPath);
    if (st.isDirectory()) {
      let count = 0;
      try {
        count = readdirSync(absPath).length;
      } catch {
        count = 0;
      }
      return { path: displayPath, kind: 'dir', exists: true, bytes: null, itemCount: count };
    }
    return { path: displayPath, kind: 'file', exists: true, bytes: st.size };
  } catch {
    return { path: displayPath, kind: 'file', exists: false, bytes: null };
  }
}

function insideWorkspace(absPath: string, sandboxRoot: string): boolean {
  const rel = path.relative(path.resolve(sandboxRoot), path.resolve(absPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 构建后果预览。`approvalMode` 只用于文案；可逆性由操作语义决定。
 */
export function buildEffectPreview(
  def: ToolDefinition,
  args: Record<string, unknown>,
  ctx: EffectContext,
  verdict: RiskVerdict,
): EffectPreview | null {
  if (def.name === 'fs.write') {
    const operation = String(args.operation ?? '');
    const rawPath = String(args.path ?? '');
    const jail = resolveInSandbox(ctx.sandboxRoot, rawPath, true, ctx.allowedDirs);
    const abs = jail.ok ? jail.absolutePath : null;
    const display = jail.ok ? jail.sandboxRelative : rawPath;

    if (!abs) {
      return {
        reversible: false,
        summary: `路径无法解析：${rawPath}`,
        items: [],
        itemCount: 0,
        recoverable: false,
        recoveryNote: null,
        grantDir: null,
      };
    }

    const item = fileItem(abs, display);
    const items: EffectItem[] = [item];
    let itemCount = 1;
    const dirCount = item.itemCount ?? 0;

    if (operation === 'rename') {
      const newPath = String(args.newPath ?? '');
      const newJail = resolveInSandbox(ctx.sandboxRoot, newPath, true, ctx.allowedDirs);
      if (newJail.ok) {
        items.push(fileItem(newJail.absolutePath, newJail.sandboxRelative));
        itemCount += 1;
      }
    }

    const recoverable = Boolean(ctx.checkpointEnabled) && insideWorkspace(abs, ctx.sandboxRoot);
    const irreversibility = FS_IRREVERSIBLE.has(operation);
    let reversible = !irreversibility;
    let summary: string;
    let recoveryNote: string | null = null;

    if (operation === 'delete') {
      summary = item.kind === 'dir'
        ? `将删除目录 ${display}（${dirCount} 个条目）`
        : `将删除文件 ${display}（${item.bytes ?? 0} 字节）`;
      itemCount = item.kind === 'dir' ? Math.max(dirCount, 1) : 1;
    } else if (operation === 'purge') {
      summary = `将清空目录 ${display}（${dirCount} 个条目），目录本身保留`;
      itemCount = Math.max(dirCount, 1);
    } else if (operation === 'overwrite') {
      summary = item.exists
        ? `将覆盖已有文件 ${display}（${item.bytes ?? 0} 字节）`
        : `目标不存在，将按覆盖语义创建 ${display}`;
      if (item.exists) {
        reversible = Boolean(ctx.checkpointEnabled);
        recoveryNote = ctx.checkpointEnabled
          ? '已有写前快照，可从证据链撤销'
          : '未开启写前快照，覆盖后原文不可恢复';
      }
    } else if (operation === 'create') {
      summary = `将创建文件 ${display}`;
    } else if (operation === 'append') {
      summary = `将向 ${display} 追加内容`;
    } else if (operation === 'rename') {
      summary = `将把 ${display} 重命名为 ${String(args.newPath ?? '')}`;
    } else {
      summary = `将写入 ${display}`;
    }

    if (verdict.approvalMode === 'two_step') {
      reversible = false;
      recoveryNote = recoveryNote ?? '两步确认后才能执行';
    }

    return {
      reversible,
      summary,
      items,
      itemCount,
      recoverable,
      recoveryNote,
    };
  }

  if (def.name === 'sys.exec') {
    const command = String(args.command ?? '');
    const execArgs = Array.isArray(args.args) ? args.args.map((v) => String(v)) : [];
    const cwd = String(args.cwd ?? '.');
    return {
      reversible: false,
      summary: `将启动进程 ${command}（参数 ${execArgs.length} 个，工作目录 ${cwd}）`,
      items: [
        { path: `${command} ${execArgs.join(' ')}`.trim(), kind: 'command', exists: true, bytes: null },
        { path: cwd, kind: 'dir', exists: true, bytes: null },
      ],
      itemCount: 1,
      recoverable: false,
      recoveryNote: '命令执行的副作用（子进程、网络、环境变更）无法通过快照撤销',
    };
  }

  if (def.name === 'http.request') {
    const method = args.method === undefined ? 'GET' : String(args.method).toUpperCase();
    if (!HTTP_WRITE_METHODS.has(method)) return null;
    const url = String(args.url ?? '');
    let host = url;
    try {
      const u = new URL(url);
      host = `${u.host}${u.pathname}`;
    } catch {
      // 保留原字符串，SSRF 闸门会先拒绝非法 URL。
    }
    return {
      reversible: false,
      summary: `${method} ${host} 会改变外部服务状态`,
      items: [{ path: `${method} ${host}`, kind: 'url', exists: true, bytes: null }],
      itemCount: 1,
      recoverable: false,
      recoveryNote: '外部服务的状态变更不在本地，无法撤销',
    };
  }

  // MCP 写操作：以 baseline 的 approvalMode 判断是否需要预览。
  if (def.source === 'mcp' && verdict.approvalMode !== 'none') {
    return {
      reversible: false,
      summary: `MCP 工具 ${def.displayName} 可能改变外部状态`,
      items: [{ path: def.displayName, kind: 'command', exists: true, bytes: null }],
      itemCount: 1,
      recoverable: false,
      recoveryNote: 'MCP 工具的副作用由服务端实现负责，无法通过本地快照撤销',
    };
  }

  return null;
}

/** 是否必须在执行前同步等复核结论。 */
export function requiresPreReview(effect: EffectPreview | null, mode: ToolApprovalMode): boolean {
  if (!effect) return mode === 'hard' || mode === 'two_step';
  return !effect.reversible;
}
