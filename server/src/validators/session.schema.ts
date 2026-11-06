/** Session endpoint validation (spec 3.3.4-3.3.10). */

import { z } from 'zod';

export const CreateSessionSchema = z.object({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  title: z.string().max(200).optional(),
});

export const RecoverSessionSchema = z.object({
  recoveryCode: z
    .string()
    .regex(/^[A-HJ-NP-Z2-9]{8}$/, '恢复码为 8 位，剔除易混字符 0/O/1/I'),
  deviceToken: z.string().max(256).optional(),
});

export const PatchSessionSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    provider: z.string().min(1).max(64).optional(),
    model: z.string().min(1).max(128).optional(),
  })
  .refine((value) => value.title !== undefined || value.provider !== undefined || value.model !== undefined, {
    message: '至少提供一个字段：title / provider / model',
  });

export const SessionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const SessionIdParamSchema = z.object({
  id: z.string().uuid(),
});
