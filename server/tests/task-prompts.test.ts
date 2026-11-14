/**
 * 任务提示词闭环测试（C3 自证：删掉任一环接线，这里必红）。
 * 覆盖：模板完备性、buildSystemPrompt 合成、schema 校验、react 通道叠加。
 * 全链路接线（HTTP → loop → 上游 system 消息）由 agent-loop-e2e.test.ts 的
 * taskKind 用例守卫。
 */

import { describe, expect, it } from 'vitest';
import { TASK_KINDS, TASK_PROMPTS, buildTaskSection, isTaskKind } from '../src/services/agent/task-prompts.js';
import { AGENT_BASE_PROMPT, AGENT_SYSTEM_PROMPT, buildSystemPrompt } from '../src/services/agent/system-prompt.js';
import { buildReactSystemPrompt } from '../src/services/agent/react-channel.js';
import { AgentRequestSchema } from '../src/validators/agent.schema.js';

const MINIMAL_BODY = { provider: 'custom', model: 'm', message: 'hi' };

describe('task prompt templates', () => {
  it('covers the README task kinds plus verify with label/sections/rules', () => {
    expect([...TASK_KINDS]).toEqual(['analyze', 'explain', 'debug', 'optimize', 'verify']);
    for (const kind of TASK_KINDS) {
      const spec = TASK_PROMPTS[kind];
      expect(spec.label.length, `${kind} label`).toBeGreaterThan(0);
      expect(spec.sections.length, `${kind} sections`).toBeGreaterThanOrEqual(3);
      expect(spec.rules.length, `${kind} rules`).toBeGreaterThanOrEqual(3);
      expect(spec.directive.length, `${kind} directive`).toBeGreaterThan(0);
    }
  });

  it('debug sections keep the README four-segment contract (问题定位/根因分析/修复建议/修复后代码)', () => {
    expect(TASK_PROMPTS.debug.sections).toEqual(['问题定位', '根因分析', '修复建议', '修复后代码']);
  });

  it('buildTaskSection renders label, directive, ordered sections and rules', () => {
    const section = buildTaskSection('debug');
    expect(section).toContain('【任务模式：调试】');
    expect(section).toContain('任务目标：');
    expect(section).toContain('【建议结构】');
    expect(section).toContain('1. 问题定位；2. 根因分析；3. 修复建议；4. 修复后代码');
    expect(section).toContain('【任务规则】');
  });

  it('isTaskKind accepts every declared kind and rejects anything else', () => {
    for (const kind of TASK_KINDS) expect(isTaskKind(kind)).toBe(true);
    expect(isTaskKind(' Analyse')).toBe(false);
    expect(isTaskKind(undefined)).toBe(false);
    expect(isTaskKind(42)).toBe(false);
  });
});

describe('buildSystemPrompt composition', () => {
  it('base prompt carries adaptive presentation rules instead of a fixed template', () => {
    for (const marker of ['【表达与版式】', '不要每轮套用同一个版式', '不使用一级标题', '禁止编造工具结果']) {
      expect(AGENT_BASE_PROMPT).toContain(marker);
    }
    expect(AGENT_BASE_PROMPT).not.toContain('【最终答案】');
  });

  it('without taskKind returns the base prompt unchanged (free chat)', () => {
    expect(buildSystemPrompt(undefined)).toBe(AGENT_BASE_PROMPT);
    expect(buildSystemPrompt()).toBe(AGENT_SYSTEM_PROMPT);
    expect(buildSystemPrompt()).not.toContain('【任务模式');
  });

  it('with taskKind appends the task section after the base', () => {
    const composed = buildSystemPrompt('optimize');
    expect(composed.startsWith(AGENT_BASE_PROMPT)).toBe(true);
    expect(composed).toContain('【任务模式：优化】');
    expect(composed).toContain('优化后代码');
  });
});

describe('AgentRequestSchema taskKind', () => {
  it('accepts each kind and defaults to undefined', () => {
    for (const kind of TASK_KINDS) {
      const parsed = AgentRequestSchema.safeParse({ ...MINIMAL_BODY, taskKind: kind });
      expect(parsed.success && parsed.data.taskKind).toBe(kind);
    }
    const bare = AgentRequestSchema.parse(MINIMAL_BODY);
    expect(bare.taskKind).toBeUndefined();
  });

  it('rejects unknown kinds (single source of truth = TASK_KINDS)', () => {
    const parsed = AgentRequestSchema.safeParse({ ...MINIMAL_BODY, taskKind: 'review' });
    expect(parsed.success).toBe(false);
  });
});

describe('buildReactSystemPrompt composition (degraded channel keeps the loop closed)', () => {
  const catalogue = '- fs.read（读取文件）：读取沙箱内文件\n  参数：\n    - path（必填）：相对路径';

  it('with baseSystem it stacks protocol on top of base + task section, not replacing them', () => {
    const base = buildSystemPrompt('debug');
    const react = buildReactSystemPrompt(catalogue, base);
    expect(react).toContain('CodeLens Agent'); // 基座身份保留
    expect(react).toContain('【任务模式：调试】'); // 任务段保留
    expect(react).toContain('【表达与版式】'); // 自适应版式契约保留
    expect(react).toContain('【文本协议】');
    expect(react).toContain('- fs.read（读取文件）：读取沙箱内文件');
    expect(react.indexOf('CodeLens Agent')).toBeLessThan(react.indexOf('【文本协议】'));
  });

  it('without baseSystem falls back to a standalone identity line (backward compatible)', () => {
    const react = buildReactSystemPrompt(catalogue);
    expect(react).toContain('你是一个通过工具完成任务的 Agent');
    expect(react).toContain('【文本协议】');
    expect(react).not.toContain('CodeLens Agent');
  });
});
