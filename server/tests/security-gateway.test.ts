/**
 * B2 (判据塔自证缺口关闭): `security-gateway` 的 assessRisk / runGateway 必须有独立破坏夹具。
 *
 * 破坏夹具性质:
 *  - 风险升级表 (POST→high/hard、delete→hard/two_step) 是「策略裁判」，必须有用例锁定；
 *  - runGateway 是「执行前总闸」，必须证明: 即使参数 schema 合法，沙箱越界 / 非 https 仍被拒
 *    (否则就是被绕过)。这些用例在策略被削平 / 闸门被开后都会变红。
 */

import { describe, it, expect } from 'vitest';
import { assessRisk, runGateway, type GatewayContext } from '../src/services/tools/security-gateway.js';
import type { ToolDefinition, ToolCategory, ToolRisk, ToolApprovalMode, ToolSource } from '../src/types/tool.js';

function makeDef(d: Partial<ToolDefinition> & Pick<ToolDefinition, 'name' | 'category'>): ToolDefinition {
  return {
    wireName: d.name.replace(/\./g, '_'),
    displayName: d.name,
    description: '',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    handler: async () => ({ ok: true, summary: 'x' }),
    timeoutMs: 1000,
    risk: 'low' as ToolRisk,
    approvalMode: 'none' as ToolApprovalMode,
    enabled: () => true,
    source: 'builtin' as ToolSource,
    idempotent: false,
    maxResultChars: 0,
    ...d,
  } as ToolDefinition;
}

const ctx: GatewayContext = { sandboxRoot: 'C:/sandbox' };

describe('security-gateway assessRisk (judge 自证 B2)', () => {
  it('http.request GET 维持 low/none 基线', () => {
    const def = makeDef({ name: 'http.request', category: 'http', risk: 'low', approvalMode: 'none' });
    const v = assessRisk(def, { method: 'GET', url: 'https://x.test' }, ctx);
    expect(v).toEqual({ risk: 'low', approvalMode: 'none' });
  });

  it('http.request POST 升级为 high/hard', () => {
    const def = makeDef({ name: 'http.request', category: 'http', risk: 'low', approvalMode: 'none' });
    const v = assessRisk(def, { method: 'POST', url: 'https://x.test' }, ctx);
    expect(v.risk).toBe('high');
    expect(v.approvalMode).toBe('hard');
  });

  it('红队: 小写 "post" 仍被升级 (大小写走私被抓)', () => {
    const def = makeDef({ name: 'http.request', category: 'http', risk: 'low', approvalMode: 'none' });
    const v = assessRisk(def, { method: 'post', url: 'https://x.test' }, ctx);
    expect(v.risk).toBe('high');
    expect(v.approvalMode).toBe('hard');
  });

  it('fs.write 删除操作升级为 hard（isRoot→two_step 死分支已移除，见 security-gateway.ts）', () => {
    // 观察项: 删除沙箱根原本的 isRoot→two_step 分支因 path-jail 对「写入根」一律拒绝
    // (path-jail.ts:80-85) 而对 fs.write 实际不可达，已从 assessRisk 移除。
    // 删除操作一律落 high/hard；two_step 仍被 executor 真实消费（TWO_STEP_PASSES），
    // 保留给未来的高危操作。本用例锁定「删除 → high/hard」这一真实策略。
    const def = makeDef({ name: 'fs.write', category: 'file', risk: 'low', approvalMode: 'none' });
    const v = assessRisk(def, { operation: 'delete', path: 'a.txt' }, ctx);
    expect(v.risk).toBe('high');
    expect(v.approvalMode).toBe('hard');
  });

  it('fs.write 删除非根文件升级为 hard', () => {
    const def = makeDef({ name: 'fs.write', category: 'file', risk: 'low', approvalMode: 'none' });
    const v = assessRisk(def, { operation: 'delete', path: 'a.txt' }, ctx);
    expect(v.risk).toBe('high');
    expect(v.approvalMode).toBe('hard');
  });

  it('fs.write purge 清空目录升级为 two_step（two_step 真实可达路径）', () => {
    // 这是 P2 清理死分支后，two_step 审批档的第一条真实触发路径：
    // 清空一个具体子目录（path-jail 不拒），而非删除沙箱根（被 path-jail 拒）。
    // 削弱本策略（purge 不再升级 two_step）时本用例会变红——证明非永真闸。
    const def = makeDef({ name: 'fs.write', category: 'file', risk: 'low', approvalMode: 'none' });
    const v = assessRisk(def, { operation: 'purge', path: 'work/data' }, ctx);
    expect(v.risk).toBe('high');
    expect(v.approvalMode).toBe('two_step');
  });
});

describe('security-gateway runGateway (judge 自证 B2)', () => {
  it('合法 schema 但路径越出沙箱被 SECURITY_DENIED (闸门不被绕过)', () => {
    const def = makeDef({
      name: 'fs.write',
      category: 'file',
      risk: 'low',
      approvalMode: 'none',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: true },
    });
    const r = runGateway(def, { path: '/etc/passwd' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SECURITY_DENIED');
  });

  it('合法 schema 但非 https URL 被 SECURITY_DENIED', () => {
    const def = makeDef({
      name: 'http.request',
      category: 'http',
      risk: 'low',
      approvalMode: 'none',
      inputSchema: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string' } }, required: ['url'], additionalProperties: true },
    });
    const r = runGateway(def, { url: 'http://example.test/', method: 'GET' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SECURITY_DENIED');
  });

  it('缺必填参数返回 INVALID_ARGS', () => {
    const def = makeDef({
      name: 'http.request',
      category: 'http',
      risk: 'low',
      approvalMode: 'none',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: true },
    });
    const r = runGateway(def, { method: 'GET' }, ctx); // 缺 url
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
  });

  it('happy path: 合法 https GET 通过并返回基线 verdict', () => {
    const def = makeDef({
      name: 'http.request',
      category: 'http',
      risk: 'low',
      approvalMode: 'none',
      inputSchema: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string' } }, required: ['url'], additionalProperties: true },
    });
    const r = runGateway(def, { url: 'https://x.test', method: 'GET' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict).toEqual({ risk: 'low', approvalMode: 'none' });
  });
});
