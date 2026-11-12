import { describe, expect, it } from 'vitest';
import { isAdoptableTarget } from '../scripts/propose-gaps.js';

/**
 * 前置任务 RC1 的自证：
 * propose-gaps 只能把 D1 叶子能力（src/tools/、src/utils/）作为可自动采纳的靶子。
 * D2（服务层首次需人批）、D3（架构层每次需人批）、D4（尺子，禁止自动改）、
 * 以及未登记路径（fail-closed 归 D3）都必须判 false —— 否则提议会在 A4 域闸被拒，
 * 白烧一轮模型调用。
 */
describe('isAdoptableTarget：只认 D1 叶子能力', () => {
  it('src/tools/ 下的工具实现是 D1 → true', () => {
    expect(isAdoptableTarget('src/tools/builtin/fs-read.tool.ts')).toBe(true);
    expect(isAdoptableTarget('src/tools/builtin/tool-forge.tool.ts')).toBe(true);
    expect(isAdoptableTarget('src/tools/builtin/expression-parser.ts')).toBe(true);
  });

  it('src/utils/ 下的纯工具是 D1 → true', () => {
    expect(isAdoptableTarget('src/utils/errors.ts')).toBe(true);
    expect(isAdoptableTarget('src/utils/digest.ts')).toBe(true);
  });

  it('src/services/ 服务层是 D2 → false（首次需人批）', () => {
    expect(isAdoptableTarget('src/services/agent/update.service.ts')).toBe(false);
    expect(isAdoptableTarget('src/services/recovery.service.ts')).toBe(false);
  });

  it('providers / controllers 属 D2 → false', () => {
    expect(isAdoptableTarget('src/providers/openai-compatible.adapter.ts')).toBe(false);
    expect(isAdoptableTarget('src/controllers/chat.controller.ts')).toBe(false);
  });

  it('src/middlewares/ 架构层是 D3 → false（每次需人批）', () => {
    expect(isAdoptableTarget('src/middlewares/error-handler.ts')).toBe(false);
    expect(isAdoptableTarget('src/app.ts')).toBe(false);
    expect(isAdoptableTarget('src/types/agent-events.ts')).toBe(false);
  });

  it('D4 尺子（tests/、scripts/）→ false（禁止自动改）', () => {
    expect(isAdoptableTarget('tests/self-upgrade/foo.test.ts')).toBe(false);
    expect(isAdoptableTarget('scripts/propose-gaps.ts')).toBe(false);
  });

  it('未登记路径 fail-closed 归 D3 → false', () => {
    expect(isAdoptableTarget('src/whatever/new-thing.ts')).toBe(false);
    expect(isAdoptableTarget('package.json')).toBe(false);
  });
});
