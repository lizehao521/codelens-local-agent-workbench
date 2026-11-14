/**
 * 工具选择判据：全量测试优先 agent.verify，禁止 sys.exec 跑完整 vitest。
 *
 * 同时锁两层：
 * 1. 系统提示词必须写出这条选择规则；
 * 2. sys.exec 静态策略必须拒绝无目标 vitest / npm test，并指向 agent.verify。
 * 单文件测试仍允许，避免把正常的定向验证误伤。
 */
import { describe, expect, it } from 'vitest';
import { AGENT_BASE_PROMPT } from '../src/services/agent/system-prompt.js';
import { evaluateExecCommand } from '../src/tools/builtin/sys-exec.policy.js';
import { fullTestVerdict } from '../src/tools/builtin/full-test-policy.js';

describe('全量测试的工具选择', () => {
  it('系统提示词要求优先 agent.verify，并禁止 sys.exec 跑完整 vitest', () => {
    expect(AGENT_BASE_PROMPT).toContain('agent.verify');
    expect(AGENT_BASE_PROMPT).toContain('禁止用 sys.exec 跑无目标的 vitest');
  });

  it('完整 vitest（无测试文件）被 sys.exec 拒绝，并给出 agent.verify 指引', () => {
    const r = evaluateExecCommand('node', ['node_modules/vitest/vitest.mjs', 'run', '--reporter=dot'], ['node']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('INVALID_ARGS');
      expect(r.message).toContain('完整 vitest');
      expect(r.suggestion ?? '').toContain('agent.verify');
    }
  });

  it('npm test / npm run test 同样被拒绝', () => {
    for (const args of [['test'], ['run', 'test']]) {
      const r = evaluateExecCommand('npm', args, ['npm']);
      expect(r.ok, args.join(' ')).toBe(false);
      if (!r.ok) expect(r.suggestion ?? '').toContain('agent.verify');
    }
  });

  it('单文件 vitest 仍允许走 sys.exec', () => {
    const r = evaluateExecCommand(
      'node',
      ['node_modules/vitest/vitest.mjs', 'run', 'tests/self-upgrade/ip-form.test.ts'],
      ['node'],
    );
    expect(r.ok).toBe(true);
    expect(fullTestVerdict('node', ['node_modules/vitest/vitest.mjs', 'run'])).not.toBeNull();
    expect(
      fullTestVerdict('node', ['node_modules/vitest/vitest.mjs', 'run', 'tests/self-upgrade/ip-form.test.ts']),
    ).toBeNull();
  });
});
