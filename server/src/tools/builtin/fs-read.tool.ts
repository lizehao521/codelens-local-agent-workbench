/** fs.read — sandboxed file reading with line windows, keyword filter and glob. */

import { readFile, stat } from 'node:fs/promises';
import type { ToolDefinition } from '../../types/tool.js';
import { resolveInSandboxAsync } from './path-jail.js';
import { globToRegExp } from './glob.js';

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

export const fsReadTool: ToolDefinition = {
  name: 'fs.read',
  wireName: 'fs_read',
  displayName: '读取文件',
  category: 'file',
  description:
    '读取沙箱内文件内容。支持 encoding（utf8/base64）、maxBytes（上限，默认 16KB）、lineStart/lineEnd（1 起的行号窗口）、keyword（只返回含该关键字的行）、glob（目录时按名过滤）。路径可以是沙箱相对路径（按沙箱根解析），也可以是授权目录内的绝对路径——相对路径不会去白名单里找。',
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
          message: `沙箱内不存在 ${jail.sandboxRelative}（相对路径只按沙箱根解析；授权目录内的文件请传绝对路径）`,
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

    let content = '';
    let lineInfo: { returned: number; total: number | null } | null = null;
    let overLimit = false;
    let truncatedBytes = false;
    const userRequestedLineStart = args.lineStart !== undefined;
    const userRequestedLineEnd = args.lineEnd !== undefined;

    if (encoding === 'utf8') {
      // 先用完整文件建立真实行号坐标系
      const fullContent = buffer.toString('utf8');
      const realAllLines = fullContent.split('\n');
      const realTotal = realAllLines.length;

      // 校验行窗口参数（基于真实总行数）
      let lineStart = userRequestedLineStart ? Number(args.lineStart) : 1;
      let lineEnd = userRequestedLineEnd ? Number(args.lineEnd) : realTotal;
      if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart) {
        return {
          ok: false,
          summary: 'lineStart/lineEnd 不合法',
          error: {
            code: 'TOOL_INVALID_ARGS',
            kind: 'invalid_args',
            message: `lineStart/lineEnd 必须为正整数且 start ≤ end（文件共 ${realTotal} 行）`,
          },
        };
      }
      // lineEnd 超出真实末尾时夹到末尾
      if (lineEnd > realTotal) lineEnd = realTotal;

      // 在真实行数组上切窗口
      let lines = realAllLines.slice(lineStart - 1, lineEnd);

      // keyword 过滤也在真实窗口上进行
      const keyword = args.keyword === undefined ? null : String(args.keyword);
      if (keyword) {
        lines = lines.filter((line) => line.includes(keyword));
      }

      // 单次返回行数上限
      overLimit = lines.length > MAX_LINES_RETURNED;
      if (overLimit) lines = lines.slice(0, MAX_LINES_RETURNED);

      // 拼接窗口内容
      content = lines.join('\n');

      // 对输出内容应用字节上限（不改变行号坐标系）
      const contentBytes = Buffer.from(content, 'utf8');
      if (contentBytes.byteLength > maxBytes) {
        truncatedBytes = true;
        const truncatedContent = contentBytes.subarray(0, maxBytes);
        content = truncatedContent.toString('utf8');
      }

      // 字节截断后重新计算实际返回的行数（total 保持真实总行数不变）
      const actualReturnedLines = content.split('\n').length;
      lineInfo = { returned: actualReturnedLines, total: realTotal };

      // 截断提示
      if (overLimit || truncatedBytes) {
        content += `\n…[截断：${overLimit ? `行数超过 ${MAX_LINES_RETURNED}（已返回 ${lineInfo.returned} 行）` : ''}${overLimit && truncatedBytes ? '，' : ''}${truncatedBytes ? `字节超过 ${maxBytes}` : ''}]`;
        content += '\n（继续读取请用 lineStart/lineEnd 分段，或用 keyword 只取命中行；也可显式调大 maxBytes）';
      }
    } else {
      // base64 分支：保持原有字节截断行为，不支持行窗口/keyword
      truncatedBytes = buffer.byteLength > maxBytes;
      const slice = truncatedBytes ? buffer.subarray(0, maxBytes) : buffer;
      content = slice.toString('base64');
      if (truncatedBytes) {
        content += `…[截断：字节超过 ${maxBytes}]`;
        content += '\n（继续读取请调大 maxBytes，或改用 encoding=utf8 配 lineStart/lineEnd 分段）';
      }
    }

    return {
      ok: true,
      summary: `已读取 ${jail.sandboxRelative}（${stats.size} 字节${lineInfo ? `，${lineInfo.total} 行` : ''}${truncatedBytes || overLimit ? '，已截断' : ''}）`,
      data: {
        kind: 'file',
        path: jail.sandboxRelative,
        encoding,
        sizeBytes: stats.size,
        // 显式请求行窗口且未被 MAX_LINES_RETURNED/字节上限进一步截断时，不视为 truncated
        truncated: truncatedBytes || overLimit || (lineInfo ? (lineInfo.returned < (lineInfo.total ?? 0) && !(userRequestedLineStart || userRequestedLineEnd)) : false),
        lines: lineInfo,
        content,
      },
    };
  },
};
