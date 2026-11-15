import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allowedForTask,
  evaluateDirtyPolicy,
  isAutomatedFlow,
} from '../../../scripts/lib/mutation-dirty-gate.mjs';

const target = 'server/src/tools/builtin/fs-write.tool.ts';
const allowed = [target];

describe('mutation --dirty gate', () => {
  it('本地显式 --dirty 且目标在 allowed 内 → 放行', () => {
    expect(evaluateDirtyPolicy({ requested: true, automated: false, target, allowed })).toEqual({
      allow: true,
      reason: `本地显式 --dirty 且目标在 allowed 内：${target}`,
    });
  });

  it('目标不在当前任务 allowed 内 → 拒绝', () => {
    const result = evaluateDirtyPolicy({
      requested: true,
      automated: false,
      target: 'server/src/outside.ts',
      allowed,
    });
    expect(result.allow).toBe(false);
    expect(result.reason).toContain('不在当前任务 allowed 内');
  });

  it('自动/CI 流程即使显式 --dirty 也强制 clean-only', () => {
    const result = evaluateDirtyPolicy({ requested: true, automated: true, target, allowed });
    expect(result.allow).toBe(false);
    expect(result.reason).toContain('clean-only');
    expect(isAutomatedFlow({ CI: '1' })).toBe(true);
    expect(isAutomatedFlow({ MUTATION_AUTO: '1' })).toBe(true);
    expect(isAutomatedFlow({})).toBe(false);
  });

  it('tasks.json allowed 归一化为仓库相对路径', () => {
    const root = path.resolve(process.cwd(), '..');
    const list = allowedForTask('fs-replace', 'server', 'server', root);
    expect(list).toContain(target);
  });

  it('_infra 使用专用 allowed 清单，loop-back 靶子可合法脏跑', () => {
    const root = path.resolve(process.cwd(), '..');
    const list = allowedForTask('_infra', 'server', 'server', root);
    expect(list).toContain('server/src/services/agent/agent-loop.service.ts');
    expect(evaluateDirtyPolicy({
      requested: true,
      automated: false,
      target: 'server/src/services/agent/agent-loop.service.ts',
      allowed: list,
    }).allow).toBe(true);
  });

  it('probe 已接入 gate，而不是只看 argv', () => {
    const src = readFileSync(path.resolve(process.cwd(), '../scripts/mutation-probe.mjs'), 'utf8');
    expect(src).toContain('evaluateDirtyPolicy');
    expect(src).toContain('isAutomatedFlow');
    expect(src).toContain('allowedForTask');
  });
});
