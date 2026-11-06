/**
 * B3 (判据塔自证缺口关闭): 形成系统化的 L3 红队层。
 *
 * 目的: 把「试图骗过裁判」的用例集中到一个独立 suite，证明各 judge 对欺骗输入
 * 都能判红 (L3 红队: 能不能骗过判据)。每个用例都是破坏夹具 —— 若对应 judge 退化，
 * 用例会变红。
 *
 * 这不是把旧用例平移，而是建立「红队」这一层；后续新增 judge 时应在此补充欺骗向量。
 */

import { describe, it, expect } from 'vitest';
import { checkFidelity, SUMMARY_SECTIONS } from '../src/services/agent/fidelity-checker.js';
import { assessRisk, type GatewayContext } from '../src/services/tools/security-gateway.js';
import { resolveInSandbox } from '../src/tools/builtin/path-jail.js';
import type { ToolDefinition, ToolCategory, ToolRisk, ToolApprovalMode, ToolSource } from '../src/types/tool.js';

const ctx: GatewayContext = { sandboxRoot: 'C:/sandbox' };

function makeHttp(): ToolDefinition {
  return {
    name: 'http.request',
    wireName: 'http_request',
    displayName: 'HTTP',
    category: 'http' as ToolCategory,
    description: '',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string' } }, required: ['url'], additionalProperties: true },
    handler: async () => ({ ok: true, summary: 'x' }),
    timeoutMs: 1000,
    risk: 'low' as ToolRisk,
    approvalMode: 'none' as ToolApprovalMode,
    enabled: () => true,
    source: 'builtin' as ToolSource,
    idempotent: false,
    maxResultChars: 0,
  } as ToolDefinition;
}

describe('L3 红队: 欺骗输入必须被裁判抓红 (judge 自证 B3)', () => {
  it('fidelity: 把九个章节名塞进一句散文不能蒙混过关', () => {
    const cheat = `本次压缩覆盖了：${SUMMARY_SECTIONS.join('、')}，以上均已处理。`;
    const result = checkFidelity(cheat);
    expect(result.ok).toBe(false);
  });

  it('security-gateway: 用小写 "post" 走私写操作仍被升级', () => {
    const def = makeHttp();
    const v = assessRisk(def, { method: 'post', url: 'https://x.test' }, ctx);
    expect(v.risk).toBe('high');
    expect(v.approvalMode).toBe('hard');
  });

  it('path-jail: 用 ".." 试图逃出沙箱被拒', () => {
    const jail = resolveInSandbox(ctx.sandboxRoot, '../escape.txt', true);
    expect(jail.ok).toBe(false);
  });

  it('path-jail: 绝对路径逃出沙箱被拒', () => {
    const jail = resolveInSandbox(ctx.sandboxRoot, '/etc/passwd', true);
    expect(jail.ok).toBe(false);
  });
});
