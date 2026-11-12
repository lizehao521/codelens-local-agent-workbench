/**
 * A2.6 参数一致性闸的自证判据。
 *
 * §12 登记的边界是：探针由出题人自己写，理论上能构造一个「调用成功、
 * 但与判据测的东西无关」的探针。A2.6 用机械比对堵它：探针必须与判据
 * 使用同一个工具变量、且第一个参数对象的键集合一致。
 *
 * 值不比 —— 判据测超时用 timeoutMs:1000、探针用 5000 是合理的。
 * 这组用例同时钉住「不许因为值不同误拒」和「不许因为键不同放过」。
 */

import { describe, expect, it } from 'vitest';
import { argsConsistencyCheck } from '../scripts/auto-adopt.js';

const JUDGE = `
import { sysExecTool } from '../../src/tools/builtin/sys-exec.tool.js';
it('超时保留部分输出', async () => {
  const r = await sysExecTool.handler!(
    { command: 'node', args: ['-e', 'console.log(1)'], timeoutMs: 1000 },
    makeCtx()
  );
  expect(r.ok).toBe(false);
});
`;

describe('A2.6 探针/判据参数一致性', () => {
  it('同一工具 + 同一键集合，值不同也放行', () => {
    const probe = `
      const r = await sysExecTool.handler!(
        { command: 'node', args: ['-e', 'console.log(1)'], timeoutMs: 5000 },
        ctx
      );
    `;
    const r = argsConsistencyCheck(JUDGE, probe);
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('args,command,timeoutMs');
  });

  it('金丝雀：探针调的是另一个工具，必须拒收', () => {
    const probe = `
      const r = await fsWriteTool.handler!(
        { command: 'node', args: [], timeoutMs: 5000 },
        ctx
      );
    `;
    const r = argsConsistencyCheck(JUDGE, probe);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('不一致');
  });

  it('金丝雀：探针用另一套调用口径（无 args），必须拒收', () => {
    // 这正是当初骗过 A3 的那组错误参数：整条命令行塞进 command。
    const probe = `
      const r = await sysExecTool.handler!(
        { command: 'node -e "console.log(1)"', timeoutMs: 5000 },
        ctx
      );
    `;
    const r = argsConsistencyCheck(JUDGE, probe);
    expect(r.ok).toBe(false);
  });

  it('判据里没有字面量参数（全用变量）时不许放行', () => {
    const judge = `const r = await sysExecTool.handler!(args, ctx);`;
    const probe = `const r = await sysExecTool.handler!({ command: 'node' }, ctx);`;
    const r = argsConsistencyCheck(judge, probe);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('判据里没有可比对');
  });

  it('探针里没有字面量参数时不许放行', () => {
    const probe = `const r = await sysExecTool.handler!(args, ctx);`;
    const r = argsConsistencyCheck(JUDGE, probe);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('探针里没有可比对');
  });

  it('嵌套对象不会让括号扫描提前截断', () => {
    const judge = `
      const r = await sysExecTool.handler!(
        { command: 'node', args: [], timeoutMs: 1000, opts: { retry: 1, nested: { deep: true } } },
        ctx
      );
    `;
    const probe = `
      const r = await sysExecTool.handler!(
        { command: 'node', args: [], timeoutMs: 5000, opts: { retry: 0, nested: { deep: false } } },
        ctx
      );
    `;
    const r = argsConsistencyCheck(judge, probe);
    expect(r.ok).toBe(true);
  });

  // ── 部分一致：同一工具、各测不同分支 ────────────────────────────────────────
  // 有些缺陷就是「某条分支被错误拒绝」，探针不可能合法走那条分支。
  // 这条放宽不能破上面两条金丝雀（另一工具 / 漏必需参数）。
  it('同一工具、两边各有独有键 → 视为测不同分支，放行', () => {
    const judge = `
      const r = await fsWriteTool.handler!(
        { path: 'dir', operation: 'delete', recursive: true },
        ctx
      );
    `;
    const probe = `
      const r = await fsWriteTool.handler!(
        { path: 'a.txt', operation: 'create', content: 'x' },
        ctx
      );
    `;
    const r = argsConsistencyCheck(judge, probe);
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('部分一致');
    expect(r.reason).toContain('operation');
  });

  it('金丝雀：探针键集合是判据的真子集（只是漏了必需参数）→ 仍拒', () => {
    // 探针没有独有键 = 它只是漏参数，不是换了个分支。
    const judge = `
      const r = await sysExecTool.handler!({ command: 'node', args: [], timeoutMs: 1000 }, ctx);
    `;
    const probe = `
      const r = await sysExecTool.handler!({ command: 'node', timeoutMs: 5000 }, ctx);
    `;
    const r = argsConsistencyCheck(judge, probe);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('不一致');
  });
});
