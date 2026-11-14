import { describe, expect, it } from 'vitest';
import { suggestNextStep } from '../src/lib/next-step';
import type { SessionMessageRow } from '../src/types';

function msg(role: 'user' | 'assistant', content: string): SessionMessageRow {
  return {
    id: `${role}-1`,
    seq: 1,
    role,
    content,
    segments: null,
    tokens: 1,
    isSummary: false,
    createdAt: 1,
  };
}

describe('suggestNextStep', () => {
  it('空会话给出一个可直接执行的起步任务', () => {
    expect(suggestNextStep([])).toContain('data');
  });

  it('上一条 assistant 提到未完成/失败时，推荐继续处理', () => {
    expect(suggestNextStep([msg('assistant', '这一步未完成：还差测试。')])).toContain('继续处理');
  });

  it('上一条 assistant 正常完成时，推荐补验证', () => {
    expect(suggestNextStep([msg('assistant', '已生成文件。')])).toContain('可验证');
  });

  it('上一条是 user 时，推荐先出计划', () => {
    expect(suggestNextStep([msg('user', '帮我改一下这个页面')])).toContain('执行计划');
  });
});
