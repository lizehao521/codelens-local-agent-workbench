/** code.check — 只解析不执行的 TypeScript 语法检查。 */

import { stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolveInSandboxAsync } from './path-jail.js';
import type { ToolDefinition, ToolOutcome } from '../../types/tool.js';

const SUPPORTED_EXT = new Set(['.ts', '.tsx', '.mts', '.cts']);

function countLines(src: string): number {
  if (src.length === 0) return 0;
  const lines = src.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function extractErrorInfo(err: unknown, src: string): { line: number; column: number; frame: string } {
  const stack = err instanceof Error ? (err.stack ?? '') : '';
  let line = 1;
  for (const l of stack.split('\n')) {
    const m = /^\s*:(\d+)\s*$/.exec(l);
    if (m) {
      line = parseInt(m[1]!, 10);
      break;
    }
  }
  const srcLines = src.split('\n');
  const frame = srcLines[line - 1] ?? '';

  // 从 stack 中找只由空格与 ^ 组成的指示行，^ 前空格数 + 1 即出错列（1-based）。
  let column = 1;
  for (const l of stack.split('\n')) {
    if (/^[ \t]*\^+[ \t]*$/.test(l)) {
      const caretIdx = l.indexOf('^');
      if (caretIdx >= 0) {
        column = caretIdx + 1;
      }
      break;
    }
  }
  // 列号必须是 1..该行长度+1 之间的真实值，否则退回 1。
  if (column < 1 || column > frame.length + 1) {
    column = 1;
  }
  return { line, column, frame };
}

export const codeCheckTool: ToolDefinition = {
  name: 'code.check',
  wireName: 'code_check',
  displayName: '检查语法',
  category: 'compute',
  description: '检查 TypeScript 源码语法（只解析不执行）。支持 .ts/.tsx/.mts/.cts。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '沙箱相对路径', maxLength: 512 },
    },
    required: ['path'],
    additionalProperties: false,
  },
  timeoutMs: 10000,
  risk: 'low',
  approvalMode: 'none',
  source: 'builtin',
  idempotent: true,
  maxResultChars: 4000,
  enabled: () => true,
  handler: async (args, ctx): Promise<ToolOutcome> => {
    const path = String(args.path ?? '');
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (!SUPPORTED_EXT.has(ext)) {
      return {
        ok: false,
        summary: `不支持的文件类型: ${ext}`,
        error: { code: 'UNSUPPORTED_FILE', kind: 'invalid_args', message: `不支持的文件类型: ${ext}` },
      };
    }

    const jail = await resolveInSandboxAsync(ctx.sandboxRoot, path, false, undefined, ctx.allowedDirs);
    if (!jail.ok) {
      return {
        ok: false,
        summary: jail.message,
        error: { code: 'TOOL_SECURITY_DENIED', kind: 'security', message: jail.message, retryable: false },
      };
    }

    let src: string;
    try {
      src = await readFile(jail.absolutePath, 'utf8');
    } catch {
      return {
        ok: false,
        summary: '文件不存在',
        error: { code: 'NOT_FOUND', kind: 'not_found', message: '文件不存在' },
      };
    }

    try {
      stripTypeScriptTypes(src, { mode: 'strip' });
    } catch (err) {
      const info = extractErrorInfo(err, src);
      return {
        ok: false,
        summary: '语法错误',
        error: {
          code: 'SYNTAX_ERROR',
          kind: 'invalid_args',
          message: err instanceof Error ? err.message : String(err),
        },
        data: { line: info.line, column: info.column, frame: info.frame },
      };
    }

    return {
      ok: true,
      summary: `语法正确，共 ${countLines(src)} 行`,
      data: { lines: countLines(src) },
    };
  },
};