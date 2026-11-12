/** fs.read — sandboxed file reading with line windows, keyword filter and glob. */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition } from '../../types/tool.js';
import { resolveInSandboxAsync } from './path-jail.js';

/**
 * 默认读取上限：16 KiB。
 *
 * 原来默认 256 KiB。注意它**不直接决定模型看到多少**——喂给模型的 observation
 * 由 executor 的 token 硬顶（OBSERVATION_MAX_TOKENS）统一裁，256 KiB 里绝大部分
 * 根本进不了上下文。这个上限真正管的是：磁盘读放大、`tool_results` 归档体积、
 * 以及 SSE `tool_result` 推给前端的 `data`（前端是全量收的，256 KiB 一次推下去
 * 足以卡住渲染）。256 KiB 在这三条上都是纯浪费。
 *
 * 16 KiB 对「读一个源文件/配置」足够；不够时工具支持 lineStart/lineEnd 与 keyword
 * 分段读，模型可以按需继续，而不是一次性把整个文件灌进上下文。
 */
const DEFAULT_MAX_BYTES = 16384;
/**
 * 单次返回的行数上限。5000 行是历史遗留的虚高值：喂给模型的 observation 有
 * token 硬顶，多切出来的行全被丢掉，纯浪费 CPU。800 行足够看一段实现；
 * 更多用 lineStart/lineEnd 分段取。
 */
const MAX_LINES_RETURNED = 800;

/** Minimal glob: `*` (no separator), `**` (any depth), `?` (one char). */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/::DOUBLE_STAR::/g, '.*')
    .replace(/\?/g, '[^/\\\\]');
  return new RegExp(`^${escaped}$`);
}

export const fsReadTool: ToolDefinition = {
  name: 'fs.read',
  wireName: 'fs_read',
  displayName: '读取文件',
  category: 'file',
  description:
    '读取沙箱内文件内容。支持 encoding（utf8/base64）、maxBytes（上限，默认 16KB）、lineStart/lineEnd（1 起的行号窗口）、keyword（只返回含该关键字的行）、glob（目录时按名过滤）。路径必须是沙箱相对路径。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '沙箱相对路径', maxLength: 512 },
      encoding: { type: 'string', enum: ['utf8', 'base64'], description: '缺省 utf8' },
      // 默认值必须与 DEFAULT_MAX_BYTES 一致（16384）。这里曾写 262144 ——
      // 常量早就刻意降到 16 KiB（理由见文件头注释：磁盘放大 / 归档体积 / SSE 推送），
      // 只有这句描述忘了跟着改，于是被当成「实现错、文档对」的缺陷提了一轮。
      maxBytes: { type: 'number', description: '读取字节上限，默认 16384（16KB）', minimum: 1, maximum: 10485760 },
      lineStart: { type: 'number', description: '起始行号（1 起，含）', minimum: 1 },
      lineEnd: { type: 'number', description: '结束行号（含）', minimum: 1 },
      keyword: { type: 'string', description: '只返回包含该关键字的行', maxLength: 200 },
      glob: { type: 'string', description: '目录路径时按 glob 过滤文件名', maxLength: 200 },
    },
    required: ['path'],
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
    const jail = await resolveInSandboxAsync(ctx.sandboxRoot, String(args.path ?? ''), false, undefined, ctx.allowedDirs);
    if (!jail.ok) {
      return {
        ok: false,
        summary: jail.message,
        error: { code: 'TOOL_SECURITY_DENIED', kind: 'security', message: jail.message, retryable: false },
      };
    }
    const encoding = args.encoding === undefined ? 'utf8' : String(args.encoding);
    if (encoding !== 'utf8' && encoding !== 'base64') {
      return {
        ok: false,
        summary: 'encoding 只支持 utf8/base64',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'encoding 只支持 utf8/base64' },
      };
    }
    const maxBytes = args.maxBytes === undefined ? DEFAULT_MAX_BYTES : Number(args.maxBytes);
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 10485760) {
      return {
        ok: false,
        summary: 'maxBytes 必须是 1-10485760 的整数',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'maxBytes 必须是 1-10485760 的整数' },
      };
    }

    let stats;
    try {
      stats = await stat(jail.absolutePath);
    } catch {
      return {
        ok: false,
        summary: `文件不存在：${jail.sandboxRelative}`,
        error: {
          code: 'TOOL_NOT_FOUND',
          kind: 'not_found',
          message: `沙箱内不存在 ${jail.sandboxRelative}`,
          retryable: false,
        },
      };
    }

    if (stats.isDirectory()) {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(jail.absolutePath);
      const glob = args.glob === undefined ? null : String(args.glob);
      const re = glob ? globToRegExp(glob) : null;
      const names = (re ? entries.filter((name) => re.test(name)) : entries).slice(0, 200);
      return {
        ok: true,
        summary: `目录 ${jail.sandboxRelative} 含 ${entries.length} 项${glob ? `，glob 命中 ${names.length} 项` : ''}`,
        data: { kind: 'directory', path: jail.sandboxRelative, entries: names, total: entries.length },
      };
    }

    ctx.reportProgress('reading', `读取 ${jail.sandboxRelative}`);
    const buffer = await readFile(jail.absolutePath);
    const truncatedBytes = buffer.byteLength > maxBytes;
    const slice = truncatedBytes ? buffer.subarray(0, maxBytes) : buffer;
    const raw = encoding === 'base64' ? slice.toString('base64') : slice.toString('utf8');

    let content = raw;
    let lineInfo: { returned: number; total: number | null } | null = null;
    if (encoding === 'utf8') {
      const allLines = raw.split('\n');
      let lines = allLines;
      const userRequestedLineStart = args.lineStart !== undefined;
      const userRequestedLineEnd = args.lineEnd !== undefined;
      const lineStart = userRequestedLineStart ? Number(args.lineStart) : 1;
      const lineEnd = userRequestedLineEnd ? Number(args.lineEnd) : allLines.length;
      if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart) {
        return {
          ok: false,
          summary: 'lineStart/lineEnd 不合法',
          error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'lineStart/lineEnd 必须为正整数且 start ≤ end' },
        };
      }
      lines = allLines.slice(lineStart - 1, lineEnd);
      const keyword = args.keyword === undefined ? null : String(args.keyword);
      if (keyword) {
        lines = lines.filter((line) => line.includes(keyword));
      }
      const overLimit = lines.length > MAX_LINES_RETURNED;
      if (overLimit) lines = lines.slice(0, MAX_LINES_RETURNED);
      content = lines.join('\n');
      lineInfo = { returned: lines.length, total: allLines.length };
      // 用户显式请求行窗口且未被 MAX_LINES_RETURNED 进一步截断时，不视为 truncated
      const explicitWindowTruncated = overLimit || truncatedBytes;
      const implicitWindowTruncated = !userRequestedLineStart && !userRequestedLineEnd && lineInfo.returned < (lineInfo.total ?? 0);
      if (explicitWindowTruncated || implicitWindowTruncated) {
        content += `\n…[截断：${overLimit ? `行数超过 ${MAX_LINES_RETURNED}（已返回 ${lineInfo?.returned ?? lines.length} 行）` : ''}${overLimit && truncatedBytes ? '，' : ''}${truncatedBytes ? `字节超过 ${maxBytes}` : ''}${implicitWindowTruncated && !overLimit && !truncatedBytes ? `，仅返回前 ${lineInfo.returned}/${lineInfo.total} 行` : ''}]`;
        content += '\n（继续读取请用 lineStart/lineEnd 分段，或用 keyword 只取命中行；也可显式调大 maxBytes）';
      }
    } else if (truncatedBytes) {
      content += `…[截断：字节超过 ${maxBytes}]`;
      content += '\n（继续读取请调大 maxBytes，或改用 encoding=utf8 配 lineStart/lineEnd 分段）';
    }

    return {
      ok: true,
      summary: `已读取 ${jail.sandboxRelative}（${stats.size} 字节${lineInfo ? `，${lineInfo.total} 行` : ''}${truncatedBytes ? '，已截断' : ''}）`,
      data: {
        kind: 'file',
        path: jail.sandboxRelative,
        encoding,
        sizeBytes: stats.size,
        truncated: truncatedBytes || (lineInfo ? (lineInfo.returned < (lineInfo.total ?? 0) && !(userRequestedLineStart || userRequestedLineEnd)) : false),
        lines: lineInfo,
        content,
      },
    };
  },
};
