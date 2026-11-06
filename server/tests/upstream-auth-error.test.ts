// 上游错误可读化 + Base URL 归一化回归
// 背景：用户遇到 relay 401，前端只吐一坨 JSON，无法自助；且 Base URL 误填 endpoint 会拼成路径翻倍。

import { describe, expect, it } from 'vitest';
import { describeHttpError } from '../src/providers/openai-compatible.adapter.js';
import { normalizeBaseUrl, resolveBaseUrl } from '../src/providers/registry.js';

const RELAY_401 = JSON.stringify({
  error: {
    message:
      '无效的 relay key（指纹 0207eaa1）。它不是本网关当前签发的 key——常见原因有三个：① 还在用旧 key；② 这份配置读的存储里没有这个 key；③ 把上游厂商的 key 当成了 relay key。到 /admin →「客户 Key」页可以核对已签发 key 的指纹。',
    type: 'authentication_error',
    code: 'invalid_key',
  },
});

describe('describeHttpError —— 认证错误可读化', () => {
  it('relay invalid_key：给出指纹 + 三条原因 + 可执行下一步（不再吐原文 JSON）', () => {
    const msg = describeHttpError(401, RELAY_401, 'sk-relay-000000000000000000000000');
    expect(msg).toContain('HTTP 401');
    expect(msg).toContain('指纹 0207eaa1');
    expect(msg).toContain('旧 key');
    expect(msg).toContain('storage.path');
    expect(msg).toContain('厂商的 key');
    expect(msg).toContain('/admin');
    // 不再原样吐 JSON
    expect(msg).not.toContain('{');
  });

  it('relay key 泄漏防护：relay 分支不回显原文，key 完全不出现在话术中', () => {
    const key = 'sk-relay-000000000000000000000000';
    const msg = describeHttpError(401, `{"error":{"message":"bad key ${key} rejected","code":"invalid_key"}}`, key);
    expect(msg).not.toContain(key);
    expect(msg).not.toContain('bad key');
  });

  it('通用认证错误回显原文时须脱敏（key 替换为 ***）', () => {
    const key = 'sk-relay-000000000000000000000000';
    const msg = describeHttpError(401, `{"error":{"message":"invalid api key: ${key}"}}`, key);
    expect(msg).not.toContain(key);
    expect(msg).toContain('***');
  });

  it('通用 401（非 relay）：提示更新 API Key，并附上脱敏原文摘要', () => {
    const msg = describeHttpError(401, '{"error":{"message":"Incorrect API key provided"}}', 'sk-x');
    expect(msg).toContain('API Key 无效');
    expect(msg).toContain('设置 → Provider');
    expect(msg).toContain('Incorrect API key provided');
  });

  it('403 走认证分支（权限/无效 key 同属凭据问题）', () => {
    const msg = describeHttpError(403, '{"error":{"message":"forbidden"}}', 'sk-x');
    expect(msg).toContain('HTTP 403');
    expect(msg).toContain('认证失败');
  });

  it('429：提示限速与查看调用限制', () => {
    const msg = describeHttpError(429, '{"error":{"message":"rate limited"}}', 'sk-x');
    expect(msg).toContain('429');
    expect(msg).toContain('限速');
    expect(msg).toContain('调用限制');
  });

  it('非认证错误保持原样（含脱敏报文），避免吞掉上游细节', () => {
    const msg = describeHttpError(500, '{"error":{"message":"boom"}}', 'sk-x');
    expect(msg).toContain('上游服务返回错误 (HTTP 500)');
    expect(msg).toContain('boom');
  });

  it('非 JSON 响应（HTML/纯文本）也走通用分支不抛异常', () => {
    const msg = describeHttpError(401, '<html>Unauthorized</html>', 'sk-x');
    expect(msg).toContain('认证失败');
  });
});

describe('normalizeBaseUrl —— Base URL 归一化', () => {
  it('剥掉误填的 /chat/completions，避免拼成路径翻倍', () => {
    expect(normalizeBaseUrl('http://121.36.29.96:8787/v1/chat/completions')).toBe('http://121.36.29.96:8787/v1');
  });

  it('循环剥离重复叠加的 endpoint', () => {
    expect(normalizeBaseUrl('http://h/v1/chat/completions/chat/completions')).toBe('http://h/v1');
  });

  it('去掉尾斜杠', () => {
    expect(normalizeBaseUrl('http://h/v1/')).toBe('http://h/v1');
  });

  it('正确填写时保持不变（不误伤 /v1）', () => {
    expect(normalizeBaseUrl('http://121.36.29.96:8787/v1')).toBe('http://121.36.29.96:8787/v1');
  });

  it('空串返回空串', () => {
    expect(normalizeBaseUrl('')).toBe('');
    expect(normalizeBaseUrl('   ')).toBe('');
  });

  it('resolveBaseUrl 对 custom 生效：不再产生 .../chat/completions/chat/completions', () => {
    const url = resolveBaseUrl('custom', 'http://121.36.29.96:8787/v1/chat/completions');
    expect(url).toBe('http://121.36.29.96:8787/v1');
  });
});
