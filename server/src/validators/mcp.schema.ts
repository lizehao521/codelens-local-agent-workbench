/** MCP endpoint validation (spec 3.3.16-3.3.21). P1 feature; routes are wired. */

import { z } from 'zod';
import { isAllowedMcpCommand } from './mcp-command.js';

// command 的 shell 元字符拒绝 + 解释器/LOLBin 拒绝 + 运行时白名单，见 mcp-command.ts。
const SENSITIVE_ENV_KEY_RE = /^(api-?key|token|secret|password|authorization|cookie)$/i;

export const CreateMcpServerSchema = z
  .object({
    name: z.string().min(1).max(64),
    command: z
      .string()
      .min(1)
      .max(256)
      .superRefine((command, ctx) => {
        const verdict = isAllowedMcpCommand(command);
        if (!verdict.ok) ctx.addIssue({ code: 'custom', message: verdict.reason });
      }),
    args: z.array(z.string().max(512)).max(32).default([]),
    env: z
      .record(z.string(), z.string().max(512))
      .refine((env) => Object.keys(env).every((key) => !SENSITIVE_ENV_KEY_RE.test(key)), {
        message: 'env 键名不得包含 apiKey/token/secret/password/authorization/cookie',
      })
      .default({}),
    cwd: z.string().max(512).optional(),
  })
  .strict();

export const PatchMcpServerSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    command: z
      .string()
      .min(1)
      .max(256)
      .superRefine((command, ctx) => {
        const verdict = isAllowedMcpCommand(command);
        if (!verdict.ok) ctx.addIssue({ code: 'custom', message: verdict.reason });
      })
      .optional(),
    args: z.array(z.string().max(512)).max(32).optional(),
    env: z.record(z.string(), z.string().max(512)).optional(),
    cwd: z.string().max(512).optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.command !== undefined ||
      value.args !== undefined ||
      value.env !== undefined ||
      value.cwd !== undefined ||
      value.enabled !== undefined,
    { message: '至少提供一个字段' },
  );

export const McpServerIdParamSchema = z.object({
  id: z.string().min(1).max(64),
});
