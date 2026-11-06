// 模型调用限制（ModelLimits）数据契约 —— 服务端 /providers limits 字段来源与同步携带
// 对应设计：docs/design/model-capability-design.md §1.2 / §1.3

import { describe, expect, it } from 'vitest';
import { LIMITS, limitsFor } from '../src/providers/capabilities.js';
import { ModelSourceSchema } from '../src/validators/model-source.schema.js';

describe('limitsFor —— provider 级调用限制默认值', () => {
  it('已知 provider 返回完整 limits', () => {
    const l = limitsFor('deepseek');
    expect(l.maxOutputTokens).toBeGreaterThan(0);
    expect(l.rateLimitRpm).toBeGreaterThan(0);
    expect(l.maxConcurrent).toBeGreaterThan(0);
    expect(l).toHaveProperty('rateLimitTpm');
  });

  it('custom 默认全未标注（null）', () => {
    const l = limitsFor('custom');
    expect(l.maxOutputTokens).toBeNull();
    expect(l.rateLimitRpm).toBeNull();
    expect(l.rateLimitTpm).toBeNull();
    expect(l.maxConcurrent).toBeNull();
  });

  it('未知 provider 回落到 custom（不抛错、不伪造）', () => {
    expect(limitsFor('nonexistent')).toEqual(LIMITS.custom);
  });
});

describe('ModelSourceSchema —— 同步目录携带 limits', () => {
  const base = {
    providers: [
      {
        id: 'openai-compatible',
        name: 'OpenAI 兼容上游',
        baseUrl: 'https://relay.example/v1',
        models: [
          {
            id: 'm1',
            name: 'model-1',
            capabilities: { function_calling: true, context_window: 128000 },
            limits: { maxOutputTokens: 4096, rateLimitRpm: 60, rateLimitTpm: 100000, maxConcurrent: 4 },
          },
        ],
      },
    ],
  };

  it('接受带 limits 的模型（含部分字段）', () => {
    const parsed = ModelSourceSchema.parse(base);
    expect(parsed.providers[0].models[0].limits?.maxOutputTokens).toBe(4096);
    expect(parsed.providers[0].models[0].limits?.rateLimitRpm).toBe(60);
  });

  it('limits 字段可选（省略不报错）', () => {
    const noLimits = {
      providers: [{ id: 'p', name: 'P', baseUrl: 'https://x/v1', models: [{ id: 'm', name: 'M' }] }],
    };
    const parsed = ModelSourceSchema.parse(noLimits);
    expect(parsed.providers[0].models[0].limits).toBeUndefined();
  });

  it('拒绝负数限制（strict 校验）', () => {
    const bad = {
      providers: [
        {
          id: 'p',
          name: 'P',
          baseUrl: 'https://x/v1',
          models: [{ id: 'm', name: 'M', limits: { rateLimitRpm: -5 } }],
        },
      ],
    };
    expect(() => ModelSourceSchema.parse(bad)).toThrow();
  });

  it('拒绝未知 limits 字段（防上游静默污染）', () => {
    const bad = {
      providers: [
        {
          id: 'p',
          name: 'P',
          baseUrl: 'https://x/v1',
          models: [{ id: 'm', name: 'M', limits: { unknownField: 1 } }],
        },
      ],
    };
    expect(() => ModelSourceSchema.parse(bad)).toThrow();
  });
});
