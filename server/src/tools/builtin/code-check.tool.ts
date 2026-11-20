/** code.check — 只解析不执行的 TypeScript 语法检查。 */

import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { resolveInSandboxAsync } from './path-jail.js';
import type { ToolDefinition, ToolOutcome } from '../../types/tool.js';

const SUPPORTED_EXT = new Set(['.ts', '.tsx', '.mts', '.cts']);

interface SyntaxErrorInfo {
  line: number;
  column: number;
  frame: string;
  message: string;
}

interface SourceFileWithParseDiagnostics {
  readonly parseDiagnostics?: readonly ts.Diagnostic[];
}

function countLines(src: string): number {
  if (src.length === 0) return 0;
  const lines = src.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function scriptKindForPath(path: string): ts.ScriptKind {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.mts':
    case '.cts':
    case '.ts':
      return ts.ScriptKind.TS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

function inspectSyntax(src: string, path: string): SyntaxErrorInfo | null {
  const sourceFile = ts.createSourceFile(
    path,
    src,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(path),
  );
  const diagnostics = (
    sourceFile as unknown as SourceFileWithParseDiagnostics
  ).parseDiagnostics;
  const diagnostic = diagnostics?.[0];
  if (diagnostic === undefined) return null;

  const start = diagnostic.start;
  const position = start === undefined
    ? { line: 0, character: 0 }
    : sourceFile.getLineAndCharacterOfPosition(start);
  const line = position.line + 1;
  const column = position.character + 1;
  const frame = src.split('\n')[position.line] ?? '';
  return {
    line,
    column,
    frame,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  };
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

    const syntaxError = inspectSyntax(src, path);
    if (syntaxError !== null) {
      return {
        ok: false,
        summary: '语法错误',
        error: {
          code: 'SYNTAX_ERROR',
          kind: 'invalid_args',
          message: syntaxError.message,
        },
        data: {
          line: syntaxError.line,
          column: syntaxError.column,
          frame: syntaxError.frame,
        },
      };
    }

    return {
      ok: true,
      summary: `语法正确，共 ${countLines(src)} 行`,
      data: { lines: countLines(src) },
    };
  },
};
