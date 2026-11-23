/**
 * gateWriteCall 纯函数判据：写闸的引擎接入形态。
 *
 * 覆盖：高占用拒绝写、context_full/circuit_open 拒绝写、读操作放行、
 * 写操作放行、阈值边界、缺失字段默认放行（向后兼容）。
 */
import { describe, expect, it } from 'vitest';
import { gateWriteCall, writeGateFor, WRITE_GATE_OCCUPANCY } from '../../src/services/agent/write-guard.js';

describe('gateWriteCall · 写闸接入形态', () => {
  it('高占用（>= 阈值）拒绝 fs_write 的写操作', () => {
    for (const operation of ['create', 'overwrite', 'append', 'replace', 'purge', 'delete', 'rename']) {
      const verdict = gateWriteCall({ occupancy: WRITE_GATE_OCCUPANCY, toolName: 'fs_write', operation });
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain('NOT_RUN');
    }
  });

  it('context_full / circuit_open 收尾原因拒绝写操作', () => {
    for (const finishReason of ['context_full', 'circuit_open']) {
      const verdict = gateWriteCall({ occupancy: 0.1, finishReason, toolName: 'fs_write', operation: 'overwrite' });
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain(finishReason);
    }
  });

  it('读操作 / 非写 operation 一律放行（即使高占用 + 异常收尾）', () => {
    expect(gateWriteCall({ occupancy: 1.5, finishReason: 'context_full', toolName: 'fs_write', operation: 'read' }).allowed).toBe(true);
    expect(gateWriteCall({ occupancy: 1.5, finishReason: 'context_full', toolName: 'fs_write', operation: '' }).allowed).toBe(true);
    expect(gateWriteCall({ occupancy: 1.5, finishReason: 'context_full', toolName: 'fs_write' }).allowed).toBe(true);
  });

  it('其它工具一律放行（即使高占用 + 异常收尾）', () => {
    expect(gateWriteCall({ occupancy: 1.5, finishReason: 'context_full', toolName: 'fs_read', operation: 'create' }).allowed).toBe(true);
    expect(gateWriteCall({ occupancy: 1.5, finishReason: 'context_full', toolName: 'sys_exec', operation: 'overwrite' }).allowed).toBe(true);
  });

  it('低占用 + 正常收尾时写操作放行', () => {
    const verdict = gateWriteCall({ occupancy: 0.5, finishReason: 'stop', toolName: 'fs_write', operation: 'create' });
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBeUndefined();
  });

  it('阈值边界：恰在阈值拒绝，阈值下 0.01 放行', () => {
    expect(gateWriteCall({ occupancy: WRITE_GATE_OCCUPANCY, toolName: 'fs_write', operation: 'overwrite' }).allowed).toBe(false);
    expect(gateWriteCall({ occupancy: WRITE_GATE_OCCUPANCY - 0.01, toolName: 'fs_write', operation: 'overwrite' }).allowed).toBe(true);
  });

  it('缺失 occupancy / finishReason 默认放行（向后兼容旧 ctx）', () => {
    expect(gateWriteCall({ toolName: 'fs_write', operation: 'overwrite' }).allowed).toBe(true);
    expect(gateWriteCall({ occupancy: null, finishReason: null, toolName: 'fs_write', operation: 'delete' }).allowed).toBe(true);
    expect(gateWriteCall({ occupancy: Number.NaN, toolName: 'fs_write', operation: 'purge' }).allowed).toBe(true);
    expect(gateWriteCall({}).allowed).toBe(true);
  });

  it('与 writeGateFor 语义一致（gateWriteCall 是其按工具/操作过滤后的形态）', () => {
    expect(gateWriteCall({ occupancy: 0.95, toolName: 'fs_write', operation: 'append' }).allowed).toBe(writeGateFor(0.95).allowed);
    expect(gateWriteCall({ occupancy: 0.2, finishReason: 'aborted', toolName: 'fs_write', operation: 'rename' }).allowed).toBe(
      writeGateFor(0.2, 'aborted').allowed,
    );
  });
});
