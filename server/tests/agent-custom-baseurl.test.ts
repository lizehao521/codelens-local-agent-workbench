/**
 * 回归：Agent 流接口 customBaseUrl 断链（2026-10-24 线上问题）。
 * 现象：设置里 provider='custom' + Base URL 已填，运行 Agent 报
 * 「Agent 内部错误：customBaseUrl is required for custom provider」——
 * 根因是 AgentRequestSchema 未声明该字段（zod 默认 strip 掉），
 * 且 registry.getProvider 不认同步层注册的上游 provider。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { AgentRequestSchema } from '../src/validators/agent.schema.js';
import {
  getProvider,
  isModelOfProvider,
  listProviders,
  resolveBaseUrl,
  setSyncedProviders,
} from '../src/providers/registry.js';

const VALID = {
  provider: 'custom',
  model: 'gpt-4o-mini',
  message: 'ping',
};

describe('AgentRequestSchema: customBaseUrl 透传', () => {
  it('接受并保留 customBaseUrl（此前被 strip 导致 custom provider 必崩）', () => {
    const parsed = AgentRequestSchema.safeParse({
      ...VALID,
      customBaseUrl: 'http://121.36.29.96:8787/v1',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.customBaseUrl).toBe('http://121.36.29.96:8787/v1');
  });

  it('修剪首尾空白', () => {
    const parsed = AgentRequestSchema.safeParse({
      ...VALID,
      customBaseUrl: '  https://relay.example/v1  ',
    });
    expect(parsed.success && parsed.data.customBaseUrl).toBe('https://relay.example/v1');
  });

  it('缺省时不报错（非 custom provider 无需该字段）', () => {
    const parsed = AgentRequestSchema.safeParse(VALID);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.customBaseUrl).toBeUndefined();
  });

  it('空串 / 超长被拒', () => {
    expect(AgentRequestSchema.safeParse({ ...VALID, customBaseUrl: '' }).success).toBe(false);
    expect(
      AgentRequestSchema.safeParse({ ...VALID, customBaseUrl: 'x'.repeat(513) }).success,
    ).toBe(false);
  });
});

describe('resolveBaseUrl', () => {
  beforeEach(() => setSyncedProviders([]));

  it('custom + 请求 URL：去掉尾部斜杠', () => {
    expect(resolveBaseUrl('custom', 'https://relay.example/v1/')).toBe('https://relay.example/v1');
  });

  it('custom + 无 URL：抛明确错误', () => {
    expect(() => resolveBaseUrl('custom')).toThrow('customBaseUrl is required for custom provider');
  });

  it('静态 provider 用自己的 baseUrl', () => {
    expect(resolveBaseUrl('deepseek')).toBe('https://api.deepseek.com/v1');
  });

  it('未知 provider：抛 unknown provider', () => {
    expect(() => resolveBaseUrl('no-such-provider')).toThrow('unknown provider: no-such-provider');
  });

  it('同步层注册的上游（openai-compatible）可解析——修复前报 unknown provider', () => {
    setSyncedProviders([
      {
        id: 'openai-compatible',
        name: 'OpenAI 兼容上游',
        baseUrl: 'http://121.36.29.96:8787/v1',
        defaultModel: 'deepseek-v4-flash',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
      },
    ]);
    expect(resolveBaseUrl('openai-compatible')).toBe('http://121.36.29.96:8787/v1');
    expect(getProvider('openai-compatible')?.name).toBe('OpenAI 兼容上游');
    expect(isModelOfProvider('openai-compatible', 'deepseek-v4-flash')).toBe(true);
    expect(isModelOfProvider('openai-compatible', 'not-a-model')).toBe(false);
  });

  it('同步层以 custom id 注册时，resolveBaseUrl 回落到同步 baseUrl', () => {
    setSyncedProviders([
      {
        id: 'custom',
        name: '中继目录',
        baseUrl: 'http://relay.internal/v1',
        defaultModel: 'm1',
        models: [{ id: 'm1', name: 'M1' }],
      },
    ]);
    expect(resolveBaseUrl('custom')).toBe('http://relay.internal/v1');
    // 请求自带 URL 仍然优先
    expect(resolveBaseUrl('custom', 'https://user.example/v1')).toBe('https://user.example/v1');
  });
});

describe('registry 合并视图', () => {
  beforeEach(() => setSyncedProviders([]));

  it('listProviders 合并静态 + 同步（同步模型优先）', () => {
    setSyncedProviders([
      {
        id: 'deepseek',
        name: 'DeepSeek 中继',
        baseUrl: 'https://relay.example/deepseek/v1',
        defaultModel: 'relay-model',
        models: [{ id: 'relay-model', name: 'Relay Model' }],
      },
    ]);
    const deepseek = listProviders().find((p) => p.id === 'deepseek');
    expect(deepseek?.name).toBe('DeepSeek 中继');
    expect(deepseek?.baseUrl).toBe('https://relay.example/deepseek/v1');
    // 同步模型优先，静态模型仍在
    expect(deepseek?.models.map((m) => m.id)).toContain('relay-model');
    expect(deepseek?.models.map((m) => m.id)).toContain('deepseek-v4-pro');
  });

  it('静态表未被同步污染（返回副本）', () => {
    setSyncedProviders([
      {
        id: 'qwen',
        name: 'Qwen 中继',
        baseUrl: 'https://relay.example/qwen/v1',
        defaultModel: 'qwen-max',
        models: [],
      },
    ]);
    const list = listProviders();
    const qwen = list.find((p) => p.id === 'qwen');
    expect(qwen?.name).toBe('Qwen 中继');
    // 改动返回副本不影响后续查询
    qwen!.models.push({ id: 'injected', name: 'Injected' });
    expect(listProviders().find((p) => p.id === 'qwen')?.models.some((m) => m.id === 'injected')).toBe(
      false,
    );
  });
});
