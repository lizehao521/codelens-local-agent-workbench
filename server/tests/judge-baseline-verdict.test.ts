import { describe, expect, it } from 'vitest';
import { judgeBaselineVerdict } from '../scripts/auto-adopt.js';

/**
 * 前置任务 RC2 的自证：出题自证红（author-task 的 finalizeCandidate）与
 * 采纳闸 A3 共用 judgeBaselineVerdict。它必须：
 *   · 绿（退出码 0）→ 拒（橡皮图章）
 *   · 假红（invalid_args / 导入失败，没走到行为）→ 拒且 premature
 *   · 全红但 0 条通过（判据整体跑不通）→ 拒
 *   · 有失败且至少 1 条通过（真红）→ 收
 * 用合成输出快测，不 spawn 真实 vitest、不写临时文件。
 */
describe('judgeBaselineVerdict：基线红判定核心', () => {
  it('退出码 0（全绿）→ 橡皮图章，拒', () => {
    const r = judgeBaselineVerdict('Test Files  1 passed\nTests  3 passed (3)', 0);
    expect(r.ok).toBe(false);
    expect(r.premature).toBe(false);
    expect(r.reason).toContain('橡皮图章');
  });

  it('no tests（没跑到任何断言）→ 拒', () => {
    const r = judgeBaselineVerdict('No test files found, exiting with code 1', 1);
    expect(r.ok).toBe(false);
    expect(r.premature).toBe(false);
  });

  it('没有 failed（无法确认红）→ 拒', () => {
    const r = judgeBaselineVerdict('Tests  2 passed (2)', 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('无法确认基线红');
  });

  it('假红：invalid_args 前置校验拒绝 → 拒并标 premature', () => {
    const r = judgeBaselineVerdict(
      'Test Files  1 failed\nTests  4 failed (4)\n  Received: invalid_args',
      1,
    );
    expect(r.ok).toBe(false);
    expect(r.premature).toBe(true);
    expect(r.reason).toContain('假红');
  });

  it('假红：Cannot find module（导入失败）→ 拒并标 premature', () => {
    const r = judgeBaselineVerdict('Tests  2 failed (2)\nCannot find module ../src/x.js', 1);
    expect(r.ok).toBe(false);
    expect(r.premature).toBe(true);
  });

  it('全红但 0 条通过（判据整体跑不通）→ 拒', () => {
    const r = judgeBaselineVerdict('Test Files  1 failed\nTests  2 failed (2)', 1);
    expect(r.ok).toBe(false);
    expect(r.premature).toBe(false);
    expect(r.reason).toContain('没有任何断言通过');
  });

  it('真红：有失败且至少 1 条通过 → 收', () => {
    const r = judgeBaselineVerdict('Test Files  1 failed\nTests  1 failed | 1 passed (2)', 1);
    expect(r.ok).toBe(true);
    expect(r.premature).toBe(false);
    expect(r.reason).toContain('基线红成立');
  });

  it('带 ANSI 色码也能正确判（真红）', () => {
    const r = judgeBaselineVerdict('\x1b[31mTests  1 failed | 2 passed (3)\x1b[39m', 1);
    expect(r.ok).toBe(true);
  });

  it('绿（退出码 0）即便输出里混有 failed 字样，仍以退出码为准判绿拒', () => {
    // 极端：退出码 0 但文本含 "failed"（例如日志），退出码优先。
    const r = judgeBaselineVerdict('some retry failed earlier\nTests  3 passed (3)', 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('橡皮图章');
  });

  // ── 分层判定：把「目标行为本身就是 invalid_args」和「判据被前置校验拦住」分开 ──
  // 实测踩过的误杀：缺陷是「inputSchema 不声明 recursive，所以传 recursive 被拒」，
  // 判据 2/3 条通过、1 条红，失败输出里出现 TOOL_INVALID_ARGS，旧逻辑一律判假红，
  // 把一条真缺陷作废了。
  it('有断言通过 + 输出含 TOOL_INVALID_ARGS → 仍是真红（invalid_args 可能就是目标行为）', () => {
    const r = judgeBaselineVerdict(
      'Test Files  1 failed\nTests  1 failed | 2 passed (3)\n  expected false to be true\n  TOOL_INVALID_ARGS',
      1,
    );
    expect(r.ok).toBe(true);
    expect(r.premature).toBe(false);
    expect(r.reason).toContain('基线红成立');
  });

  it('一条都没通过 + TOOL_INVALID_ARGS → 假红（整体被前置校验拦住）', () => {
    const r = judgeBaselineVerdict('Test Files  1 failed\nTests  3 failed (3)\n  TOOL_INVALID_ARGS', 1);
    expect(r.ok).toBe(false);
    expect(r.premature).toBe(true);
    expect(r.reason).toContain('假红');
  });

  it('硬错误优先：即便有断言通过，Cannot find module 仍判假红', () => {
    const r = judgeBaselineVerdict(
      'Tests  1 failed | 2 passed (3)\nCannot find module ../src/nope.js',
      1,
    );
    expect(r.ok).toBe(false);
    expect(r.premature).toBe(true);
  });
});
