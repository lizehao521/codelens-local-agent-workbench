// P1-6 回看水合单测 —— 刷新/跨设备恢复后工具审计链必须重建。
// 缺陷背景：GET /sessions/:id 一直返回 toolCalls，但 selectSession 只消费
// messages，toolCallStore.byId 为空 → 消息里所有 tool 段渲染 null（时间线整体丢失）。
// 覆盖：行→视图模型映射 / hydrate 整体替换语义 / messageId 挂靠 / selectSession 端到端。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDetail, SessionToolCallRow } from '../src/types';
import { rowToToolCallVM, useToolCallStore } from '../src/stores/toolCallStore';
import { useServerSessionStore } from '../src/stores/serverSessionStore';

function toolRow(patch: Partial<SessionToolCallRow> = {}): SessionToolCallRow {
  return {
    id: 'tc_1',
    callId: 'call_1',
    messageId: 'msg_a1',
    toolName: 'fs.read',
    displayName: '读取文件',
    category: 'file',
    source: 'builtin',
    risk: 'medium',
    approvalMode: 'none',
    channel: 'native',
    iteration: 1,
    arguments: { path: 'data/a.txt' },
    status: 'success',
    resultSummary: '读取成功：12 行',
    resultRef: 'res_1',
    durationMs: 42,
    truncated: false,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_042,
    errorKind: null,
    errorMessage: null,
    ...patch,
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

beforeEach(() => {
  useToolCallStore.getState().reset();
  useServerSessionStore.setState({ messages: [], activeSessionId: null, lastError: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rowToToolCallVM（P1-6 审计行 → 视图模型）', () => {
  it('成功行：摘要/耗时/时间戳/截断标记全量映射', () => {
    const vm = rowToToolCallVM(toolRow());
    expect(vm.callId).toBe('call_1');
    expect(vm.name).toBe('fs.read');
    expect(vm.displayName).toBe('读取文件');
    expect(vm.status).toBe('success');
    expect(vm.summary).toBe('读取成功：12 行');
    expect(vm.resultText).toBe('读取成功：12 行');
    expect(vm.resultKind).toBe('text');
    expect(vm.durationMs).toBe(42);
    expect(vm.startedAt).toBe(1_700_000_000_000);
    expect(vm.endedAt).toBe(1_700_000_000_042);
    expect(vm.truncated).toBeUndefined();
    expect(vm.retryCount).toBe(0);
    expect(vm.error).toBeUndefined();
  });

  it('截断行带 truncated 标记（卡片展示「已截断」）', () => {
    const vm = rowToToolCallVM(toolRow({ truncated: true }));
    expect(vm.truncated).toBe(true);
  });

  it('失败行：errorMessage 原文进 error.message，errorKind 同时作 code 与 kind', () => {
    const vm = rowToToolCallVM(
      toolRow({ status: 'failed', resultSummary: null, errorKind: 'security', errorMessage: '路径越界' }),
    );
    expect(vm.status).toBe('failed');
    expect(vm.summary).toBeUndefined();
    expect(vm.resultText).toBeUndefined();
    expect(vm.error).toEqual({ code: 'security', kind: 'security', message: '路径越界' });
  });

  it('失败行缺 errorMessage 时按 errorKind 合成占位文案（不静默丢错误）', () => {
    const vm = rowToToolCallVM(toolRow({ status: 'timeout', errorKind: 'timeout', errorMessage: null }));
    expect(vm.error?.message).toContain('timeout');
    expect(vm.error?.kind).toBe('timeout');
  });

  it('极简行（全 null）：可选字段全部缺席，终态原样透传', () => {
    const vm = rowToToolCallVM(
      toolRow({
        displayName: null,
        resultSummary: null,
        durationMs: null,
        startedAt: null,
        endedAt: null,
        status: 'rejected',
      }),
    );
    expect(vm.displayName).toBeUndefined();
    expect(vm.summary).toBeUndefined();
    expect(vm.durationMs).toBeUndefined();
    expect(vm.startedAt).toBeUndefined();
    expect(vm.status).toBe('rejected');
    expect(vm.error).toBeUndefined();
  });
});

describe('toolCallStore.hydrate（P1-6 整体替换语义）', () => {
  it('水合后 byId / byMessage 按 messageId 挂靠，时序保持行序', () => {
    useToolCallStore.getState().hydrate([
      toolRow({ callId: 'c1', messageId: 'm1' }),
      toolRow({ callId: 'c2', messageId: 'm1' }),
      toolRow({ callId: 'c3', messageId: 'm2' }),
    ]);
    const state = useToolCallStore.getState();
    expect(Object.keys(state.byId).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(state.byMessage).toEqual({ m1: ['c1', 'c2'], m2: ['c3'] });
  });

  it('messageId 为 null（所属消息已删）的行进 byId 但不挂靠任何消息', () => {
    useToolCallStore.getState().hydrate([toolRow({ callId: 'c9', messageId: null })]);
    const state = useToolCallStore.getState();
    expect(state.byId.c9).toBeDefined();
    expect(state.byMessage).toEqual({});
  });

  it('整体替换而非合并：旧会话/旧运行的残留卡片被清掉', () => {
    useToolCallStore.getState().hydrate([toolRow({ callId: 'old', messageId: 'm1' })]);
    useToolCallStore.getState().hydrate([toolRow({ callId: 'new', messageId: 'm2' })]);
    const state = useToolCallStore.getState();
    expect(state.byId.old).toBeUndefined();
    expect(state.byId.new).toBeDefined();
    expect(state.byMessage).toEqual({ m2: ['new'] });
  });
});

describe('selectSession 端到端水合（P1-6 回归）', () => {
  it('详情里的 toolCalls 重建工具存储，消息 tool 段可解析', async () => {
    const detail: SessionDetail = {
      session: {
        id: 'sess_1',
        title: '回看会话',
        provider: 'openai',
        model: 'gpt-4o-mini',
        channelMode: 'auto',
        degraded: false,
        messageCount: 3,
        totalTokens: 120,
        createdAt: 1,
        updatedAt: 2,
      },
      messages: [
        {
          id: 'msg_u',
          seq: 1,
          role: 'user',
          content: '读一下文件',
          segments: [{ type: 'text', text: '读一下文件' }],
          tokens: 5,
          isSummary: false,
          createdAt: 10,
        },
        {
          id: 'msg_a1',
          seq: 2,
          role: 'assistant',
          content: '',
          segments: [
            { type: 'text', text: '我来读取' },
            { type: 'tool', callId: 'c1' },
            { type: 'tool', callId: 'c2' },
          ],
          tokens: 30,
          isSummary: false,
          createdAt: 11,
        },
      ],
      toolCalls: [
        toolRow({ id: 'tc_1', callId: 'c1', messageId: 'msg_a1', status: 'success' }),
        toolRow({
          id: 'tc_2',
          callId: 'c2',
          messageId: 'msg_a1',
          toolName: 'http.request',
          category: 'http',
          status: 'failed',
          resultSummary: '请求被拒绝',
          errorKind: 'security',
          errorMessage: '主机不在白名单',
        }),
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/api/v1/sessions/sess_1')) return jsonResponse(detail);
        return jsonResponse({});
      }),
    );

    await useServerSessionStore.getState().selectSession('sess_1');

    const state = useToolCallStore.getState();
    // 两张卡片都在（此前缺陷：全部渲染 null）
    expect(state.byId.c1?.status).toBe('success');
    expect(state.byId.c2?.status).toBe('failed');
    expect(state.byId.c2?.error?.message).toBe('主机不在白名单');
    expect(state.byMessage.msg_a1).toEqual(['c1', 'c2']);
    // 消息本体也已装入
    expect(useServerSessionStore.getState().messages.map((m) => m.id)).toEqual(['msg_u', 'msg_a1']);
    expect(useServerSessionStore.getState().lastError).toBeNull();
  });

  it('详情加载失败时清空工具存储，不残留上个会话的卡片', async () => {
    useToolCallStore.getState().hydrate([toolRow({ callId: 'stale', messageId: 'm1' })]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) }) as Response),
    );

    await useServerSessionStore.getState().selectSession('sess_x');

    expect(useToolCallStore.getState().byId.stale).toBeUndefined();
    expect(useServerSessionStore.getState().lastError).toBe('boom');
  });
});
