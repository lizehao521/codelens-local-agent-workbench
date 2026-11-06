// 撤销二次确认 + 焦点归属（审计台）：
//  - 正常例：确认后才发 POST；取消不发（金丝雀：把「先执行再问」打红）；
//  - 安全默认焦点落在「取消」；
//  - 撤销完成后焦点回到触发按钮，而不是 BODY。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AuditView } from '../src/components/agent/AuditView';
import type { RunAuditResponse } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function auditFixture(): RunAuditResponse {
  const writeFile = {
    path: 'demo/a.txt',
    operation: 'write' as const,
    step: 1,
    checkpointId: 'cp_1',
    toolCallIds: ['call_1'],
    added: 1,
    removed: 1,
    diff: '@@ -1 +1 @@\n-old\n+new\n',
    beforeSha256: 'a'.repeat(64),
    afterSha256: 'b'.repeat(64),
  };
  const createFile = {
    path: 'demo/new.txt',
    operation: 'create' as const,
    step: 1,
    checkpointId: 'cp_1',
    toolCallIds: ['call_1'],
    added: 2,
    removed: 0,
    diff: '@@ -0,0 +1,2 @@\n+hello\n+world\n',
    beforeSha256: null,
    afterSha256: 'c'.repeat(64),
  };
  return {
    runId: 'run-undo',
    report: null,
    budget: null,
    cost: null,
    stages: [],
    approvals: [],
    files: [
      {
        path: writeFile.path,
        operation: 'write',
        steps: [{ step: 1, checkpointId: 'cp_1', status: 'active', restoredAt: null, toolCallIds: ['call_1'] }],
      },
      {
        path: createFile.path,
        operation: 'create',
        steps: [{ step: 1, checkpointId: 'cp_1', status: 'active', restoredAt: null, toolCallIds: ['call_1'] }],
      },
    ],
    steps: [
      {
        step: 1,
        checkpointId: 'cp_1',
        createdAt: Date.now(),
        status: 'active',
        restoredAt: null,
        toolCallIds: ['call_1'],
        files: [writeFile, createFile],
      },
    ],
    fileCount: 2,
    totalBytes: 100,
    undo: { runAvailable: true, activeSnapshots: 1 },
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

function mountWithCalls(calls: Array<{ method: string; url: string }>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      if (method === 'POST') {
        return jsonResponse({ ok: true, restored: ['demo/a.txt'], deleted: ['demo/new.txt'], kept: [] });
      }
      return jsonResponse(auditFixture());
    }),
  );
  act(() => root.render(createElement(AuditView, { runId: 'run-undo' })));
}

function findButton(text: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text)) ?? null
  );
}

describe('审计台撤销：确认 + 焦点', () => {
  it('默认焦点在「取消」；取消不发 POST（金丝雀）', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    mountWithCalls(calls);
    await flush();

    const undoBtn = findButton('撤销整个 run');
    expect(undoBtn).toBeTruthy();
    act(() => undoBtn!.click());

    const dialog = container.querySelector<HTMLElement>('[data-testid="undo-confirm-dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain('将恢复 1 个文件、删除 1 个新建文件');
    // 安全选项默认获得焦点。
    expect(document.activeElement?.textContent).toContain('取消');

    const cancel = findButton('取消');
    act(() => cancel!.click());
    await flush();

    // 金丝雀：取消绝不能调用 rollback（若实现退化成「先执行再问」，这里会红）。
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(container.querySelector('[data-testid="undo-confirm-dialog"]')).toBeNull();
  });

  it('确认后执行一次，焦点回到触发按钮而非 BODY', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    mountWithCalls(calls);
    await flush();

    const undoBtn = findButton('撤销整个 run');
    expect(undoBtn).toBeTruthy();
    act(() => undoBtn!.click());
    const confirm = findButton('确认撤销');
    expect(confirm).toBeTruthy();
    act(() => confirm!.click());
    await flush();

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(container.querySelector('[data-testid="undo-confirm-dialog"]')).toBeNull();
    // 焦点归属：不能落到 BODY，且应回到发起撤销的按钮。
    expect(document.activeElement?.tagName).not.toBe('BODY');
    expect(document.activeElement?.textContent).toContain('撤销整个 run');
  });
});
