/**
 * Upstream model-source response contract (§6 default contract).
 * strict() + refine: reject unknown/duplicate ids so a malformed upstream
 * cannot silently corrupt the local provider configuration.
 */

import { z } from 'zod';

const ModelCapabilitiesSchema = z
  .object({
    function_calling: z.boolean().optional(),
    context_window: z.number().int().positive().optional(),
  })
  .strict();

const ModelLimitsSchema = z
  .object({
    maxOutputTokens: z.number().int().positive().optional(),
    rateLimitRpm: z.number().int().positive().optional(),
    rateLimitTpm: z.number().int().positive().optional(),
    maxConcurrent: z.number().int().positive().optional(),
  })
  .strict();

const ModelSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    capabilities: ModelCapabilitiesSchema.optional(),
    limits: ModelLimitsSchema.optional(),
  })
  .strict();

const ProviderSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(128),
    baseUrl: z.string().min(1).max(512),
    defaultModel: z.string().max(128).optional().default(''),
    docsUrl: z.string().max(512).optional().default(''),
    models: z.array(ModelSchema).default([]),
  })
  .strict();

export const ModelSourceSchema = z
  .object({
    providers: z.array(ProviderSchema).min(1, 'providers 不能为空'),
  })
  .strict()
  .refine(
    (data) => {
      const pids = new Set<string>();
      for (const p of data.providers) {
        if (pids.has(p.id)) return false;
        pids.add(p.id);
        const mids = new Set<string>();
        for (const m of p.models) {
          if (mids.has(m.id)) return false;
          mids.add(m.id);
        }
      }
      return true;
    },
    { message: 'provider.id / model.id 必须全局唯一' },
  );

export type ModelSourceProvider = z.infer<typeof ProviderSchema>;
export type ModelSource = z.infer<typeof ModelSourceSchema>;
