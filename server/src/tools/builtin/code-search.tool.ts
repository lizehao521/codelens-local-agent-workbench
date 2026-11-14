/** code.search — sandboxed content search across files. */

import type { ToolDefinition } from '../../types/tool.js';
import path from 'node:path';
import { resolveInSandboxAsync } from './path-jail.js';
import { walkFiles, MAX_FILE_SIZE } from './sandbox-walk.js';
import { globToRegExp } from './glob.js';

export const codeSearchTool: ToolDefinition = {
  name: 'code.search',
  wireName: 'code_search',
  displayName: '按内容查找代码',
  category: 'file',
  description:
    '在沙箱内按内容搜索文件。支持字面量匹配（默认大小写不敏感）与正则模式，可按文件名 glob 过滤。返回命中行的文件相对路径、行号与整行原文。自动跳过 node_modules/dist/coverage/.git、符号链接、二进制文件与超大文件。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（字面量或正则）', maxLength: 500 },
      path: { type: 'string', description: '搜索根目录（沙箱相对路径），缺省 "."', maxLength: 512 },
      caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
      regex: { type: 'boolean', description: '是否按正则解释 pattern，默认 false' },
      glob: { type: 'string', description: '文件名 glob 过滤（basename），如 *.ts', maxLength: 200 },
      maxResults: { type: 'number', description: '返回上限，默认 50，最大 500', minimum: 1, maximum: 500 },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  timeoutMs: 15000,
  risk: 'low',
  approvalMode: 'none',
  source: 'builtin',
  idempotent: true,
  maxResultChars: 8000,
  enabled: () => true,
  handler: async (args, ctx) => {
    const pattern = args.pattern === undefined ? '' : String(args.pattern).trim();
    if (!pattern) {
      return {
        ok: false,
        summary: 'pattern 不能为空',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'pattern 不能为空', retryable: false },
      };
    }

    const caseSensitive = args.caseSensitive === true;
    const regexMode = args.regex === true;
    const globPattern = args.glob === undefined ? '' : String(args.glob).trim();

    const maxResults = args.maxResults === undefined ? 50 : Number(args.maxResults);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500) {
      return {
        ok: false,
        summary: 'maxResults 必须是 1-500 的整数',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'maxResults 必须是 1-500 的整数', retryable: false },
      };
    }

    let searchRegex: RegExp;
    try {
      if (regexMode) {
        searchRegex = new RegExp(pattern, caseSensitive ? '' : 'i');
      } else {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        searchRegex = new RegExp(escaped, caseSensitive ? '' : 'i');
      }
    } catch {
      return {
        ok: false,
        summary: '非法正则表达式',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: '非法正则表达式', retryable: false },
      };
    }

    let globRegex: RegExp | undefined;
    if (globPattern) {
      try {
        globRegex = globToRegExp(globPattern);
      } catch {
        return {
          ok: false,
          summary: '非法 glob 模式',
          error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: '非法 glob 模式', retryable: false },
        };
      }
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

    const hits: Array<{ file: string; line: number; text: string }> = [];
    let total = 0;
    let filesScanned = 0;

    const { readFile, stat } = await import('node:fs/promises');

    for await (const file of walkFiles(jail.absolutePath, ctx.sandboxRoot, { glob: globRegex })) {
      filesScanned++;
      const absoluteFile = path.join(ctx.sandboxRoot, file);

      // Check file size first (fast stat)
      let fileStats;
      try {
        fileStats = await stat(absoluteFile);
      } catch {
        continue; // Skip unreadable files
      }
      if (fileStats.size > MAX_FILE_SIZE) {
        continue; // Skip files larger than 1 MiB
      }

      // Read file content and check for binary (null byte)
      let content: string;
      try {
        const buffer = await readFile(absoluteFile);
        if (buffer.includes(0x00)) {
          continue; // Skip binary files
        }
        content = buffer.toString('utf8');
      } catch {
        continue; // Skip unreadable files
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!; // split('\n') never produces sparse arrays
        if (searchRegex.test(line)) {
          total++;
          if (hits.length < maxResults) {
            hits.push({ file, line: i + 1, text: line });
          }
        }
      }
    }

    return {
      ok: true,
      summary: `code.search 命中 ${total} 处${hits.length < total ? `，返回前 ${hits.length} 处` : ''}`,
      data: {
        hits,
        total,
        truncated: hits.length < total,
        filesScanned,
      },
    };
  },
};