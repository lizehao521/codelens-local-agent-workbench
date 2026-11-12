/**
 * 出题前置机械筛的自证判据。
 *
 * 实测：提议池 append-only 攒到 6 条，出题器不加筛就逐条调模型 ——
 * 其中 1 条已完成、2 条靶子落在需人批的域、1 条靶子根本不存在。
 * 每条几十秒，产出的候选最后还会被 A4 域闸拒掉。
 * 这些判断都不需要模型，必须在 askAuthor 之前做完。
 */

import { describe, expect, it } from 'vitest';
import { authorPrecheck, type AuthorPrecheckInput } from '../scripts/author-task.js';

const base: AuthorPrecheckInput = {
  id: 'error-next-action',
  targetFile: 'src/tools/builtin/fs-write.tool.ts', // D1 工具层：可全自动
  doneIds: [],
  archived: false,
  targetExists: true,
};

describe('出题前置机械筛', () => {
  it('D1 工具层、靶子存在、未做过 → 放行', () => {
    const r = authorPrecheck(base);
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('D1');
  });

  it('金丝雀：已完成的题不重复出题', () => {
    expect(authorPrecheck({ ...base, doneIds: [base.id] }).ok).toBe(false);
  });

  it('金丝雀：已归档的候选题不重复出题', () => {
    expect(authorPrecheck({ ...base, archived: true }).ok).toBe(false);
  });

  it('金丝雀：靶子不存在时直接拒收（模型编路径）', () => {
    const r = authorPrecheck({ ...base, targetFile: 'src/middlewares/request-log.ts', targetExists: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('靶子不存在');
  });

  it('金丝雀：D2 服务层需人批，不自动出题', () => {
    const r = authorPrecheck({ ...base, targetFile: 'src/services/agent/agent-loop.service.ts' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('D2');
  });

  it('金丝雀：D3 架构层需人批，不自动出题', () => {
    const r = authorPrecheck({ ...base, targetFile: 'src/app.ts' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('D3');
  });

  it('金丝雀：D4 判据层一律禁止，不自动出题', () => {
    const r = authorPrecheck({ ...base, targetFile: 'tests/self-upgrade/x.test.ts' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('D4');
  });
});
