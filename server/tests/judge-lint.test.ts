/**
 * 判据机械闸（judgeLint）的自证。
 *
 * 3 条真实教训换来的约束：
 *  1. 判据断言不存在的 error.kind（precondition_failed）→ 自证红闸会当成真红放行，
 *     接着 Agent 为满足判据把实现改成返回非法 kind → tsc TS2322，整次升级作废。
 *  2. 判据断言 summary 文案（'deleted'）→ 中文摘要被改成英文来迎合判据，判据在带坏实现。
 *  3. 判据不许 import 目标模块以外的业务模块（否则可以读实现细节凑断言）。
 */
import { describe, expect, it } from 'vitest';
import { judgeLint } from '../scripts/author-task.js';

const TARGET = 'src/tools/builtin/fs-write.tool.ts';

const base = (extra = '') => `
import { describe, expect, it } from 'vitest';
import { fsWriteTool } from '../../src/tools/builtin/fs-write.tool.js';
describe('d', () => {
  it('a', () => { expect(1).toBe(1); });
  it('b', () => { expect(1).toBe(1); });
  it('c', () => { expect(1).toBe(1); });
  ${extra}
});
`;

describe('judgeLint：判据机械闸', () => {
  it('合规判据放行', () => {
    expect(judgeLint(base(), TARGET).ok).toBe(true);
  });

  it('断言不存在的 kind（precondition_failed）→ 拒，并列出合法值', () => {
    const r = judgeLint(base(`it('d', () => { expect(result.error?.kind).toBe('precondition_failed'); });`), TARGET);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('precondition_failed');
    expect(r.reason).toContain('invalid_args');
  });

  it('断言语义等价的 kind 别名（not_found 之外的造词）→ 拒', () => {
    const r = judgeLint(base(`it('d', () => { expect(res.error.kind).toEqual('file_missing'); });`), TARGET);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('file_missing');
  });

  it('断言合法 kind → 放行（invalid_args 是枚举内的值）', () => {
    const r = judgeLint(base(`it('d', () => { expect(result.error?.kind).toBe('invalid_args'); });`), TARGET);
    expect(r.ok).toBe(true);
  });

  it('断言 summary 文案 → 拒（会把实现带偏：中文摘要被改成英文）', () => {
    const r = judgeLint(base(`it('d', () => { expect(result.summary).toContain('deleted'); });`), TARGET);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('summary');
  });

  it('toBeTruthy 不误伤（不是 toBe + 严格括号）', () => {
    const r = judgeLint(base(`it('d', () => { expect(result.summary).toBeTruthy(); });`), TARGET);
    expect(r.ok).toBe(true);
  });

  it('import 目标模块以外的业务模块 → 拒', () => {
    const src = base().replace(
      "import { fsWriteTool } from '../../src/tools/builtin/fs-write.tool.js';",
      "import { fsWriteTool } from '../../src/tools/builtin/fs-write.tool.js';\nimport { x } from '../../src/services/secret.js';",
    );
    const r = judgeLint(src, TARGET);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('不许 import');
  });

  it('少于 3 条断言 → 拒', () => {
    const src = `
import { describe, expect, it } from 'vitest';
import { fsWriteTool } from '../../src/tools/builtin/fs-write.tool.js';
describe('d', () => { it('a', () => { expect(1).toBe(1); }); });
`;
    const r = judgeLint(src, TARGET);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('至少要 3 条');
  });

  it('skip/only → 拒', () => {
    const r = judgeLint(base(`it.skip('d', () => {});`), TARGET);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('skip');
  });
});
