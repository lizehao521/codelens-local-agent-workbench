/**
 * E1 判据：MCP 工具的 annotations 出现冲突信号时必须 fail-closed。
 *
 * 督导探针实证（修复前）：
 *   gradeMcpRisk({ readOnlyHint: true, destructiveHint: true }) → { low, none }
 * 即：server 一边声明"只读"、一边声明"破坏性"时，实现按 readOnly 优先返回零审批，
 * 把明确的破坏性信号压了下去。冲突输入下应选择更保守的一侧（destructive 优先），
 * 否则一个自相矛盾的 annotations 就能拿到 none 门槛。
 *
 * 本判据只钉冲突裁决方向，不改变任何"单一 hint"的既有语义（见后三条回归保护）。
 */
import { describe, expect, it } from 'vitest';
import { gradeMcpRisk, adaptMcpTool } from '../src/services/mcp/mcp-tool-adapter.js';
import type { McpManagerService } from '../src/services/mcp/mcp-manager.service.js';

const stubManager = { isConnected: () => true } as unknown as McpManagerService;
const schema = { type: 'object', properties: {} };

describe('E1：MCP annotations 冲突信号必须 fail-closed', () => {
  it('readOnly=true 且 destructive=true → high/hard（破坏性信号优先，不得被只读压过）', () => {
    const v = gradeMcpRisk({ readOnlyHint: true, destructiveHint: true });
    expect(v.risk).toBe('high');
    expect(v.approvalMode).toBe('hard');
  });

  it('回归保护：readOnly=true 单独 → low/none（既有语义不变）', () => {
    const v = gradeMcpRisk({ readOnlyHint: true, destructiveHint: false });
    expect(v.risk).toBe('low');
    expect(v.approvalMode).toBe('none');
  });

  it('回归保护：destructive=true 单独 → high/hard', () => {
    const v = gradeMcpRisk({ readOnlyHint: false, destructiveHint: true });
    expect(v.risk).toBe('high');
    expect(v.approvalMode).toBe('hard');
  });

  it('回归保护：无 annotations → medium/soft', () => {
    const v = gradeMcpRisk(undefined);
    expect(v.risk).toBe('medium');
    expect(v.approvalMode).toBe('soft');
  });

  it('REV-1：冲突信号工具不得被登记为 idempotent（破坏性操作不可自动重试）', () => {
    const def = adaptMcpTool('srv', {
      name: 'danger', inputSchema: schema,
      annotations: { readOnlyHint: true, destructiveHint: true },
    }, stubManager)!;
    expect(def.risk).toBe('high');
    expect(def.approvalMode).toBe('hard');
    expect(def.idempotent).toBe(false);
  });

  it('回归保护：单纯 readOnly 工具仍 idempotent=true（超时可安全重试）', () => {
    const def = adaptMcpTool('srv', {
      name: 'search', inputSchema: schema,
      annotations: { readOnlyHint: true },
    }, stubManager)!;
    expect(def.idempotent).toBe(true);
  });
});
