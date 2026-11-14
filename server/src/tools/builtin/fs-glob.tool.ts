/** fs.glob — sandboxed file pattern matching. */

import type { ToolDefinition } from '../../types/tool.js';
import path from 'node:path';
import { resolveInSandboxAsync } from './path-jail.js';
import { walkFiles } from './sandbox-walk.js';
import { globToRegExp } from './glob.js';

export const fsGlobTool: ToolDefinition = {
  name: 'fs.glob',
  wireName: 'fs_glob',
  displayName: '按模式查找文件',
  category: 'file',
  description:
    '在沙箱内按 glob 模式查找文件。支持 `*`（不跨分隔符）、`**`（任意深度）、`?`（单字符）。返回按路径排序的文件列表，自动跳过 node_modules/dist/coverage/.git，不跟随符号链接。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，如 *.ts 或 **/*.ts', maxLength: 200 },
      path: { type: 'string', description: '搜索根目录（沙箱相对路径），缺省 "."', maxLength: 512 },
      maxResults: { type: 'number', description: '返回上限，默认 200，最大 1000', minimum: 1, maximum: 1000 },
    },
    required: ['pattern'],
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
    const pattern = args.pattern === undefined ? '' : String(args.pattern);
    if (!pattern) {
      return {
        ok: false,
        summary: 'pattern 不能为空',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'pattern 不能为空', retryable: false },
      };
    }

    const maxResults = args.maxResults === undefined ? 200 : Number(args.maxResults);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 1000) {
      return {
        ok: false,
        summary: 'maxResults 必须是 1-1000 的整数',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'maxResults 必须是 1-1000 的整数', retryable: false },
      };
    }

    const rootPath = args.path === undefined ? '.' : String(args.path);
    const jail = await resolveInSandboxAsync(ctx.sandboxRoot, rootPath, false, undefined, ctx.allowedDirs);
    if (!jail.ok) {
      return {
        ok: false,
        summary: jail.message,
        error: { code: 'TOOL_SECURITY_DENIED', kind: 'security', message: jail.message, retryable: false },
      };
    }

    let stats;
    try {
      stats = await (await import('node:fs/promises')).stat(jail.absolutePath);
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
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: `${jail.sandboxRelative} 不是目录`, retryable: false },
      };
    }

    const regex = globToRegExp(pattern);
    const matches: string[] = [];
    let total = 0;

    // When path is a subdirectory, we need to match against paths relative to that subdirectory
    // but return paths relative to sandbox root
    const rootRelative = path.relative(ctx.sandboxRoot, jail.absolutePath).replace(/\\/g, '/');
    const isSubdir = rootRelative !== '';

    for await (const file of walkFiles(jail.absolutePath, ctx.sandboxRoot)) {
      // file is already sandbox-relative
      // For matching, use path relative to the search root if it's a subdirectory
      const matchPath = isSubdir ? path.relative(rootRelative, file).replace(/\\/g, '/') : file;
      
      if (regex.test(matchPath)) {
        total++;
        if (matches.length < maxResults) {
          matches.push(file);
        }
      }
    }

    matches.sort();

    return {
      ok: true,
      summary: `glob "${pattern}" 命中 ${total} 个文件${matches.length < total ? `，返回前 ${matches.length} 个` : ''}`,
      data: {
        matches,
        total,
        truncated: matches.length < total,
      },
    };
  },
};