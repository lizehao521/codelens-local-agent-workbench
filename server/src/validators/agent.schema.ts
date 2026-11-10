/** AgentRequest validation (spec 3.3.11). resumeFromCallId/overrideArguments serve AC-10. */

import { z } from 'zod';
import { TASK_KINDS } from '../services/agent/task-prompts.js';

export const AgentRequestSchema = z.object({
  sessionId: z.string().uuid().optional(),
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  apiKey: z.string().min(1).max(512).optional(),
  // 四类任务模式（README「四类核心能力」）：经 buildSystemPrompt 注入任务段，
  // react 通道同样叠加。枚举值单一来源 = TASK_KINDS，缺省 = 自由对话。
  taskKind: z.enum(TASK_KINDS).optional(),
  // 自定义 Provider（provider='custom'）的自带 Base URL。非 custom  provider 忽略。
  // 历史上仅 legacy chat 接口透传该字段，Agent 流接口漏掉 → resolveBaseUrl 抛
  // 「customBaseUrl is required for custom provider」（2026-10-24 修复）。
  customBaseUrl: z.string().trim().min(1).max(512).optional(),
  message: z.string().min(1).max(32000),
  tools: z.array(z.string().min(1).max(64)).max(64).optional(),
  channelMode: z.enum(['auto', 'native', 'react']).default('auto'),
  /**
   * 是否为「测量轮」。默认 true（历史行为）。
   * 置 false 时本 run 照常判决/学习，但**不**进入 RSI 跨代对账 ——
   * 用于把「Agent 干活」与「固定探针测量」分开，避免开发轮的噪声污染代际读数。
   */
  rsiMeasure: z.boolean().default(true),
  /**
   * 测量采样次数。>1 时本 run 的对账读数取「最近 N 次判决」的均值 ——
   * 单次作答的语义覆盖率有 ±0.03 级噪声，取均值才能让"严格变好"对应真实差异。
   * 只在 rsiMeasure=true 时生效。
   */
  rsiMeasureSamples: z.number().int().min(1).max(9).default(1),
  maxIterations: z.number().int().min(5).max(30).default(12),
  temperature: z.number().min(0).max(2).default(0.3),
  maxTokens: z.number().int().min(64).max(8192).default(2048),
  // AC-10 intervention fields: single-step retry (callId only) and run-from-step
  // (callId + overrideArguments). Both reuse the same loop — no second engine.
  resumeFromCallId: z.string().min(1).max(128).optional(),
  overrideArguments: z.record(z.string(), z.unknown()).optional(),
});

export type AgentRequestInput = z.infer<typeof AgentRequestSchema>;
