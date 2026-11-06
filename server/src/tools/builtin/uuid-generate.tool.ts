/** uuid.generate — CSPRNG uuid v4 batch. */

import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '../../types/tool.js';

export const uuidGenerateTool: ToolDefinition = {
  name: 'uuid.generate',
  wireName: 'uuid_generate',
  displayName: '生成 UUID',
  category: 'compute',
  description: '生成一个或多个 uuid v4（密码学随机源）。count 1-100，缺省 1。',
  inputSchema: {
    type: 'object',
    properties: {
      count: { type: 'number', description: '生成数量，1-100，缺省 1', minimum: 1, maximum: 100 },
    },
    additionalProperties: false,
  },
  timeoutMs: 5000,
  risk: 'low',
  approvalMode: 'none',
  source: 'builtin',
  idempotent: false,
  maxResultChars: 4000,
  enabled: () => true,
  handler: async (args) => {
    const count = args.count === undefined ? 1 : Number(args.count);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      return {
        ok: false,
        summary: 'count 必须是 1-100 的整数',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'count 必须是 1-100 的整数' },
      };
    }
    const uuids = Array.from({ length: count }, () => randomUUID());
    return {
      ok: true,
      summary: `已生成 ${count} 个 uuid v4`,
      data: { uuids, count },
    };
  },
};
