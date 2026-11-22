/** Plan endpoint validation (P1-4 可编辑计划面板). */

import { z } from 'zod';

/** 单个计划步骤：标题必填，detail 可选；status 仅服务端维护，客户端不可伪造。 */
export const PlanStepInputSchema = z.object({
  title: z.string().trim().min(1).max(500),
  detail: z.string().max(4000).optional(),
});

export const CreatePlanSchema = z.object({
  title: z.string().trim().max(200).optional(),
  steps: z.array(PlanStepInputSchema).min(1).max(50),
});

/** 整体替换（改步骤 / 删步骤 / 重排都通过提交新的有序数组表达，天然幂等）。 */
export const ReplacePlanSchema = z.object({
  title: z.string().trim().max(200).optional(),
  steps: z.array(PlanStepInputSchema).min(1).max(50),
});

export const PlanIdParamSchema = z.object({
  planId: z.string().uuid(),
});

export const SessionIdParamSchema = z.object({
  sessionId: z.string().uuid(),
});

export const PlanListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
