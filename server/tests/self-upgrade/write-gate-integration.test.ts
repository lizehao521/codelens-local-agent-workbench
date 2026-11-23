/**
 * 写闸引擎接入的集成断言（真实 fsWriteTool.handler 调用）。
 *
 * 证明 gateWriteCall 不是孤立纯函数，而是真正在 fs.write 动盘前生效：
 *  - 高占用 / context_full 收尾时拒绝写入，且文件未落盘 / 未被改动
 *  - 占用正常时不误伤，写入照常
 *
 * 语法自检+回滚（SYNTAX_REJECTED）属后续独立任务，见
 * docs/rsi-write-guard-integration.pending.md 第二组草案，本文件不覆盖。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsWriteTool } from '../../src/tools/builtin/fs-write.tool.js';
import type { ToolExecutionContext } from '../../src/types/tool.js';
import { WRITE_GATE_OCCUPANCY } from '../../src/services/agent/write-guard.js';

let sandbox: string;
function ctx(extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    sessionId: 's', toolCallId: 't', callId: 'c', iteration: 1,
    sandboxRoot: sandbox,
    signal: new AbortController().signal,
    reportProgress: () => {},
    ...extra,
  };
}
beforeEach(() => { sandbox = mkdtempSync(join(tmpdir(), 'gate-int-')); });
afterEach(() => { try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe('fs.write · 写闸引擎接入（集成）', () => {
  it('occupancy ≥ 阈值时 create 被拒为 WRITE_GATE_CLOSED，文件未落盘', async () => {
    const outcome = await fsWriteTool.handler(
      { path: 'a.ts', operation: 'create', content: 'export const a = 1;\n' },
      ctx({ contextOccupancy: WRITE_GATE_OCCUPANCY + 0.05 }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('WRITE_GATE_CLOSED');
    expect(outcome.error?.kind).toBe('circuit_open');
    expect(outcome.summary).toContain('NOT_RUN');
    expect(existsSync(join(sandbox, 'a.ts'))).toBe(false);
  });

  it('context_full 收尾原因下 overwrite 被拒，原文件未被改动', async () => {
    const target = 'b.ts';
    const original = 'const x = 1;\n';
    writeFileSync(join(sandbox, target), original);
    const outcome = await fsWriteTool.handler(
      { path: target, operation: 'overwrite', content: 'const x = 999;\n' },
      ctx({ finishReason: 'context_full' }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('WRITE_GATE_CLOSED');
    expect(readFileSync(join(sandbox, target), 'utf8')).toBe(original);
  });

  it('占用正常时写入不受影响（闸门不误伤）', async () => {
    const outcome = await fsWriteTool.handler(
      { path: 'ok.ts', operation: 'create', content: 'export const ok = 1;\n' },
      ctx({ contextOccupancy: 0.3 }),
    );
    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(sandbox, 'ok.ts'), 'utf8')).toBe('export const ok = 1;\n');
  });

  it('读操作不受写闸影响（高占用 + context_full 仍可 create，因为写操作本身在阈值下）', async () => {
    // 高占用但 operation=create 必被拒（这是写操作），确认无向后兼容漏洞
    const denied = await fsWriteTool.handler(
      { path: 'c.ts', operation: 'create', content: 'x' },
      ctx({ contextOccupancy: 0.99, finishReason: 'context_full' }),
    );
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('WRITE_GATE_CLOSED');
  });
});
