/** fs.list — sandboxed directory listing (non-recursive by default). */

import { readdir, stat } from 'node:fs/promises';
import type { ToolDefinition } from '../../types/tool.js';
import { resolveInSandboxAsync } from './path-jail.js';

export const fsListTool: ToolDefinition = {
  name: 'fs.list',
  wireName: 'fs_list',
  displayName: '浏览目录',
  category: 'file',
  description: '列出沙箱内目录内容（名称/类型/大小）。recursive=true 时递归（默认关），maxEntries 上限默认 200。路径可以是沙箱相对路径（按沙箱根解析）或授权目录内的绝对路径。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '沙箱相对路径，缺省 "."', maxLength: 512 },
      recursive: { type: 'boolean', description: '是否递归，缺省 false' },
      maxEntries: { type: 'number', description: '返回条目上限，默认 200，最大 1000', minimum: 1, maximum: 1000 },
    },
    additionalProperties: false,
  },
  timeoutMs: 15000,
  risk: 'low',
  approvalMode: 'none',
  source: 'builtin',
  idempotent: true,
  maxResultChars: 4000,
  enabled: () => true,
  handler: async (args, ctx) => {
    const jail = await resolveInSandboxAsync(ctx.sandboxRoot, String(args.path ?? '.'), false, undefined, ctx.allowedDirs);
    if (!jail.ok) {
      return {
        ok: false,
        summary: jail.message,
        error: { code: 'TOOL_SECURITY_DENIED', kind: 'security', message: jail.message, retryable: false },
      };
    }
    const maxEntries = args.maxEntries === undefined ? 200 : Number(args.maxEntries);
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000) {
      return {
        ok: false,
        summary: 'maxEntries 必须是 1-1000 的整数',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'maxEntries 必须是 1-1000 的整数' },
      };
    }

    let stats;
    try {
      stats = await stat(jail.absolutePath);
    } catch {
      return {
        ok: false,
        summary: `目录不存在：${jail.sandboxRelative}`,
        error: {
          code: 'TOOL_NOT_FOUND',
          kind: 'not_found',
          message: `沙箱内不存在 ${jail.sandboxRelative}`,
          retryable: false,
        },
      };
    }
    if (!stats.isDirectory()) {
      return {
        ok: false,
        summary: `${jail.sandboxRelative} 不是目录`,
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: `${jail.sandboxRelative} 不是目录` },
      };
    }

    ctx.reportProgress('listing', `浏览 ${jail.sandboxRelative}`);
    const entries: Array<{ name: string; type: 'file' | 'dir' | 'other'; sizeBytes: number | null }> = [];
    // BFS（逐层）而不是 DFS：DFS 会先把第一棵子树钻到底，一个大目录就能把
    // maxEntries 配额吃光，当前层的文件（含软链）根本排不上。列表语义天然
    // 是「先看到有什么」，更深的内容按层展开才对。
    const queue: Array<{ dir: string; prefix: string; depth: number }> = [
      { dir: jail.absolutePath, prefix: '', depth: 0 },
    ];
    let complete = true;
    while (queue.length > 0) {
      if (entries.length >= maxEntries) {
        complete = false;
        break;
      }
      const { dir, prefix, depth } = queue.shift()!;
      let dirEntries;
      try {
        dirEntries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of dirEntries) {
        if (entries.length >= maxEntries) {
          complete = false;
          break;
        }
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        // 软链只报「有这个东西」，绝不跟进去：跟进去会泄露沙箱外目标的
        // sizeBytes / 目录内子条目（sizeBytes 恒 null，type 恒 other）。
        if (entry.isSymbolicLink()) {
          entries.push({ name, type: 'other', sizeBytes: null });
          continue;
        }
        const abs = `${dir}/${entry.name}`;
        try {
          const s = await stat(abs);
          entries.push({
            name,
            type: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other',
            sizeBytes: s.isFile() ? s.size : null,
          });
          if (s.isDirectory() && args.recursive === true && depth < 6) {
            queue.push({ dir: abs, prefix: name, depth: depth + 1 });
          }
        } catch {
          entries.push({ name, type: 'other', sizeBytes: null });
        }
      }
    }

    return {
      ok: true,
      summary: `${jail.sandboxRelative}：${entries.length} 项${complete ? '' : '（已达上限）'}`,
      data: { kind: 'directory', path: jail.sandboxRelative, entries, complete },
    };
  },
};
