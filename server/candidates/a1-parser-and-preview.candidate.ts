import { describe, expect, it } from 'vitest';
import { parseReactOutput } from '../src/services/agent/react-parser.js';
import { buildEffectPreview } from '../src/services/tools/effect-preview.js';
import type { ToolDefinition, RiskVerdict } from '../src/types/tool.js';

const parseCalls = (text: string) => {
  const r = parseReactOutput(text);
  return r.kind === 'calls' ? r : null;
};

const def = (name: string): ToolDefinition => ({
  name, wireName: name, displayName: name, category: 'fs', description: '',
  inputSchema: { type: 'object' }, handler: async () => ({} as never), timeoutMs: 1000,
  risk: 'medium', approvalMode: 'soft', enabled: () => true, source: 'builtin',
  idempotent: false, maxResultChars: 1000,
});
const verdict: RiskVerdict = { risk: 'medium', approvalMode: 'soft' };

describe('A-1 轮督导判据', () => {
  // A1-A: L3 正则不得把嵌套对象里的 arguments 误当顶层参数
  it('A1-A: L3 嵌套 arguments 不应被当作顶层参数', () => {
    const text = 'data={"foo":1} then "tool": "bar", "data": {"arguments": {"nested": true}} end';
    const r = parseCalls(text);
    expect(r).not.toBeNull();
    expect(r!.toolCalls[0].name).toBe('bar');
    // 顶层没有 arguments 字段 → 必须是空对象，不能是嵌套的 {nested:true}
    expect(r!.toolCalls[0].arguments).toEqual({});
  });

  it('A1-A 回归保护: L3 顶层 arguments 仍正常解析', () => {
    const text = 'data={"foo":1} then "tool": "bar", "arguments": {"x":1} end';
    const r = parseCalls(text);
    expect(r).not.toBeNull();
    expect(r!.toolCalls[0].arguments).toEqual({ x: 1 });
  });

  // A1-B-1: rename 目标在工作区外（allowedDirs 授权）被覆盖时，不得标记可恢复
  it('A1-B-1: rename 目标在工作区外覆盖时 recoverable=false', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-a1-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-a1-out-'));
    fs.writeFileSync(path.join(sandbox, 'a.txt'), 'AAA');
    fs.writeFileSync(path.join(outside, 'target.txt'), 'ORIGINAL');
    const preview = buildEffectPreview(
      def('fs.write'),
      { operation: 'rename', path: 'a.txt', newPath: path.join(outside, 'target.txt') },
      { sandboxRoot: sandbox, checkpointEnabled: true, allowedDirs: [outside] },
      verdict,
    );
    expect(preview).not.toBeNull();
    expect(preview!.reversible).toBe(true);
    // 目标在工作区外，不在 checkpoint 快照范围，覆盖后不可恢复
    expect(preview!.recoverable).toBe(false);
  });

  // A1-B-3: sys.exec 的 itemCount 应与 items.length 一致
  it('A1-B-3: sys.exec itemCount 与 items.length 一致', () => {
    const preview = buildEffectPreview(
      def('sys.exec'),
      { command: 'ls', args: ['-la'], cwd: '/tmp' },
      { sandboxRoot: '/tmp' },
      verdict,
    );
    expect(preview).not.toBeNull();
    expect(preview!.itemCount).toBe(preview!.items.length);
  });
});
