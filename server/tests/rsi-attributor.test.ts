/**
 * rsi-attributor 纯函数测试 —— 归因经验能不能进 π。
 *
 * 只测纯逻辑（抽 LESSON、截断判定），不打网络：归因本身依赖上游 LLM，
 * 它属于"实测"范畴，由 seed-agent-loop 端到端跑出来验证。
 */
import { describe, it, expect } from 'vitest';
import { extractLesson, isCompleteLesson } from '../src/services/rsi/rsi-attributor.js';

describe('extractLesson', () => {
  it('标准格式 LESSON: xxx', () => {
    expect(extractLesson('LESSON: 逐条覆盖缺失词项。')).toBe('逐条覆盖缺失词项。');
  });

  it('中文冒号与「经验：」前缀', () => {
    expect(extractLesson('经验：先核对参数。')).toBe('先核对参数。');
  });

  it('无前缀时取第一行正文', () => {
    expect(extractLesson('# 标题\n直接给一句经验。')).toBe('直接给一句经验。');
  });

  it('空输出 → null', () => {
    expect(extractLesson('   \n ')).toBeNull();
  });
});

describe('isCompleteLesson（截断闸）', () => {
  it('句末标点 → 完整', () => {
    expect(isCompleteLesson('补齐缺失词项。')).toBe(true);
    expect(isCompleteLesson('done.')).toBe(true);
  });

  it('句中被迫中断 → 判为截断（不许入 π）', () => {
    expect(isCompleteLesson('goal_term_coverage 两代停滞，说明只覆盖了顺')).toBe(false);
    expect(isCompleteLesson('先核对参数、')).toBe(false);
  });

  it('无输出不算截断（由调用方按"无输出"处理）', () => {
    expect(isCompleteLesson(null)).toBe(true);
  });
});
