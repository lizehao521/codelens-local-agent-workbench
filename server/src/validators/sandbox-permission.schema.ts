/** Sandbox permission endpoint validation (spec: 沙箱权限配置). */

import { z } from 'zod';

export const AutoApproveSchema = z.object({
  fsDestructive: z.boolean().optional(),
  purge: z.boolean().optional(),
  httpWrite: z.boolean().optional(),
});

export const SandboxPermissionUpdateSchema = z.object({
  /** 用户提交的「完整替换列表」（原始绝对路径），逐条服务端硬校验。 */
  allowDirs: z.array(z.string()).optional(),
  autoApprove: AutoApproveSchema.optional(),
});

export type SandboxPermissionUpdateInput = z.infer<typeof SandboxPermissionUpdateSchema>;
