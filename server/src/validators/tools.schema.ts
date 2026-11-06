/** Tools endpoint validation (spec 3.3.14 / 3.3.15). */

import { z } from 'zod';

export const ToolNameParamSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, '工具名必须为点号规范名'),
});

export const PatchToolSchema = z.object({
  enabled: z.boolean(),
});

export const ToolListQuerySchema = z.object({
  source: z.enum(['builtin', 'mcp']).optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  category: z.enum(['http', 'file', 'compute', 'mcp']).optional(),
});
