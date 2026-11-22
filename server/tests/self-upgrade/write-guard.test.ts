/**
 * write-guard 纯函数判据。
 *
 * 范围说明（诚实边界）：
 *   writeGateFor / firstSyntaxError 是纯函数，可独立验证，已全绿。
 *   "把写闸接进 fs.write 执行循环"属于引擎改造，前一轮 RSI 的接入尝试
 *   在 context_full 收尾时写出了语法残片，已剔除（详见 RSI迭代结果.md 第十三章）。
 *   引擎接入完成前，集成断言不适用于当前代码库，故不在本测试文件内。
 *   接入待办与当时的集成测试草案归档在 docs/rsi/write-guard-integration.pending.md。
 */
import { describe, expect, it } from 'vitest';
import { firstSyntaxError, writeGateFor, WRITE_GATE_OCCUPANCY } from '../../src/services/agent/write-guard.js';

describe('write-guard · writeGateFor 纯规则', () => {
  it('占用低于阈值且无收尾原因时放行', () => {
    expect(writeGateFor(0.5).allowed).toBe(true);
    expect(writeGateFor(WRITE_GATE_OCCUPANCY - 0.01).allowed).toBe(true);
  });

  it('占用达到阈值时拒绝并给出 NOT_RUN 原因', () => {
    const verdict = writeGateFor(WRITE_GATE_OCCUPANCY);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('NOT_RUN');
    expect(verdict.reason).toContain('90.0%');
  });

  it('异常收尾原因（context_full / circuit_open 等）一律拒绝', () => {
    for (const reason of ['context_full', 'circuit_open', 'budget_exhausted', 'max_iterations', 'aborted', 'stream_interrupted']) {
      const verdict = writeGateFor(0.1, reason);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain(reason);
    }
  });

  it('正常收尾原因（stop / converged）不触发写闸', () => {
    expect(writeGateFor(0.1, 'stop').allowed).toBe(true);
    expect(writeGateFor(0.1, 'converged').allowed).toBe(true);
  });
});

describe('write-guard · firstSyntaxError 语法闸', () => {
  it('合法 TS 返回 null', () => {
    expect(firstSyntaxError('export const a = 1;\n', 'a.ts')).toBeNull();
  });

  it('重复函数体 / 孤立残片（第三轮事故形态）被抓出行号', () => {
    const broken = [
      'export function f(): number {',
      '  return 1;',
      '}',
      'export function f(): number {', // 重复粘贴
      '  return 2;',
      // 缺少闭合 —— 孤立残片
    ].join('\n');
    const issue = firstSyntaxError(broken, 'broken.ts');
    expect(issue).not.toBeNull();
    expect(issue!.line).toBeGreaterThan(0);
    expect(issue!.message.length).toBeGreaterThan(0);
  });

  it('未闭合括号报错', () => {
    expect(firstSyntaxError('function g( {\n', 'g.ts')).not.toBeNull();
  });
});
