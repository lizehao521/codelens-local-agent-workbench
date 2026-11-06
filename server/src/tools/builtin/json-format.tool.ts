/** json.format — pretty/compact/sort-keys/validate plus JSON Pointer extraction. */

import type { ToolDefinition } from '../../types/tool.js';

/** Minimal RFC 6901 JSON Pointer: "" = whole doc, "/a/b/0" = path segments. */
function resolvePointer(doc: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === '') return { found: true, value: doc };
  if (!pointer.startsWith('/')) return { found: false };
  let current: unknown = doc;
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false };
      current = current[index];
    } else if (current !== null && typeof current === 'object') {
      if (!(segment in (current as Record<string, unknown>))) return { found: false };
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

const MAX_INPUT_CHARS = 1_000_000;

export const jsonFormatTool: ToolDefinition = {
  name: 'json.format',
  wireName: 'json_format',
  displayName: 'JSON 处理',
  category: 'compute',
  description:
    '处理 JSON：mode=pretty（缩进美化）/compact（压缩）/sort-keys（键排序美化）/validate（仅校验）。可选 path 用 JSON Pointer（如 "/data/0/name"）提取子片段。',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'JSON 文本', maxLength: 1000000 },
      mode: { type: 'string', enum: ['pretty', 'compact', 'sort-keys', 'validate'], description: '处理模式，缺省 pretty' },
      path: { type: 'string', description: 'JSON Pointer，缺省整个文档', maxLength: 512 },
    },
    required: ['input'],
    additionalProperties: false,
  },
  timeoutMs: 5000,
  risk: 'low',
  approvalMode: 'none',
  source: 'builtin',
  idempotent: true,
  maxResultChars: 4000,
  enabled: () => true,
  handler: async (args) => {
    const input = String(args.input ?? '');
    if (input.length > MAX_INPUT_CHARS) {
      return {
        ok: false,
        summary: `输入超过 ${MAX_INPUT_CHARS} 字符上限`,
        error: { code: 'PAYLOAD_TOO_LARGE', kind: 'invalid_args', message: `输入超过 ${MAX_INPUT_CHARS} 字符上限` },
      };
    }
    const mode = args.mode === undefined ? 'pretty' : String(args.mode);
    if (!['pretty', 'compact', 'sort-keys', 'validate'].includes(mode)) {
      return {
        ok: false,
        summary: 'mode 必须是 pretty/compact/sort-keys/validate',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'mode 必须是 pretty/compact/sort-keys/validate' },
      };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: 'JSON 解析失败',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: `JSON 解析失败：${message}` },
      };
    }

    if (args.path !== undefined) {
      const pointer = resolvePointer(doc, String(args.path));
      if (!pointer.found) {
        return {
          ok: false,
          summary: `JSON Pointer "${String(args.path)}" 未命中`,
          error: {
            code: 'TOOL_INVALID_ARGS',
            kind: 'invalid_args',
            message: `JSON Pointer "${String(args.path)}" 未命中文档`,
          },
        };
      }
      doc = pointer.value;
    }

    if (mode === 'validate') {
      return { ok: true, summary: 'JSON 合法', data: { valid: true } };
    }
    const rendered =
      mode === 'compact' ? JSON.stringify(doc) : JSON.stringify(mode === 'sort-keys' ? sortKeysDeep(doc) : doc, null, 2);
    return {
      ok: true,
      summary: mode === 'compact' ? '已压缩为单行 JSON' : mode === 'sort-keys' ? '已按键排序美化' : '已美化',
      data: { output: rendered ?? 'null', mode, bytes: Buffer.byteLength(rendered ?? '') },
    };
  },
};
