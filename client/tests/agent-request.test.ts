import { describe, it, expect } from 'vitest';
import { TASK_MODES, buildAgentStreamRequest, rerunFromPatch } from '../src/lib/agent-request';
import type { Settings } from '../src/types';

const settings: Settings = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  apiKey: '  sk-test  ',
  theme: 'dark',
  channelMode: 'auto',
};

describe('buildAgentStreamRequest（AUDIT-006 taskKind 接线）', () => {
  it('正常例：patch.taskKind 透传进请求体', () => {
    const req = buildAgentStreamRequest(settings, '帮我定位', 'sess-1', { taskKind: 'debug' });
    expect(req.taskKind).toBe('debug');
    expect(req.sessionId).toBe('sess-1');
  });

  it('正常例：不选任务模式时不带 taskKind（自动语义）', () => {
    const req = buildAgentStreamRequest(settings, 'hi', 'sess-1');
    expect(req.taskKind).toBeUndefined();
  });

  it('破坏夹具：若 builder 丢弃 patch.taskKind 必红', () => {
    const req = buildAgentStreamRequest(settings, 'x', 's', { taskKind: 'optimize' });
    expect(req.taskKind, 'taskKind 必须透传').toBe('optimize');
  });

  it('执行方式透传：plan / goal 都进入请求体', () => {
    for (const executionMode of ['plan', 'goal'] as const) {
      const req = buildAgentStreamRequest(settings, 'x', 's', { executionMode });
      expect(req.executionMode).toBe(executionMode);
    }
  });

  it('任务模式齐全（与服务端 TASK_KINDS 同集合）', () => {
    expect(TASK_MODES.map((m) => m.value)).toEqual(['analyze', 'explain', 'debug', 'optimize', 'verify']);
  });
});

describe('rerunFromPatch（AUDIT-008 从某步重跑携带 overrideArguments）', () => {
  it('正常例：携带 overrideArguments 与 resumeFromCallId', () => {
    const patch = rerunFromPatch('call_1', { path: 'a.txt' });
    expect(patch).toEqual({ resumeFromCallId: 'call_1', overrideArguments: { path: 'a.txt' } });
  });

  it('正常例：无参数时仅 resumeFromCallId', () => {
    expect(rerunFromPatch('call_2')).toEqual({ resumeFromCallId: 'call_2' });
  });

  it('破坏夹具：overrideArguments 被丢弃会转红', () => {
    const patch = rerunFromPatch('call_3', { url: 'https://x' });
    expect(patch.overrideArguments, 'overrideArguments 必须透传').toEqual({ url: 'https://x' });
  });
});