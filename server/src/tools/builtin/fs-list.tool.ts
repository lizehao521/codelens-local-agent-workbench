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
    const walk = async (dir: string, prefix: string, depth: number): Promise<boolean> => {
      if (entries.length >= maxEntries) return false;
      const names = await readdir(dir);
      for (const name of names) {
        if (entries.length >= maxEntries) return false;
        const abs = `${dir}/${name}`;
        try {
          const s = await stat(abs);
          entries.push({
            name: prefix ? `${prefix}/${name}` : name,
            type: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other',
            sizeBytes: s.isFile() ? s.size : null,
          });
          if (s.isDirectory() && args.recursive === true && depth < 6) {
            const proceed = await walk(abs, prefix ? `${prefix}/${name}` : name, depth + 1);
            if (!proceed) return false;
          }
        } catch {
          entries.push({ name: prefix ? `${prefix}/${name}` : name, type: 'other', sizeBytes: null });
        }
      }
      return true;
    };
    const complete = await walk(jail.absolutePath, '', 0);

    return {
      ok: true,
      summary: `${jail.sandboxRelative}：${entries.length} 项${complete ? '' : '（已达上限）'}`,
      data: { kind: 'directory', path: jail.sandboxRelative, entries, complete },
    };
  },
};
