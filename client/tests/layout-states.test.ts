// F：布局与四态回归 —— 空态 / 等待态 / 错误态 / 冲突态，审计台键盘可达，
// 以及 D 的大文件/多文件渲染边界（虚拟滚动后 DOM 行数有界、实测耗时可读）。
// 断言只做可观察行为（文案 / role / data-state / DOM 数量），不耦合实现细节。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../src/App';
import { AuditView } from '../src/components/agent/AuditView';
import { ResumeConflictCard } from '../src/components/agent/ResumeConflictCard';
import { RunInspector } from '../src/components/agent/RunInspector';
import { RunReportCard } from '../src/components/agent/RunReportCard';
import { useRunStore } from '../src/stores/runStore';
import { useToolCallStore } from '../src/stores/toolCallStore';
import type { RunAuditResponse, RunReport } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function report(overrides: Partial<RunReport>): RunReport {
  return {
    runId: 'run-1',
    sessionId: 'sess-1',
    outcome: 'completed',
    statusCode: 'RUN_COMPLETED',
    reason: null,
    notDone: [],
    status: 'ok',
    finishReason: 'stop',
    durationMs: 1200,
    iteration: 2,
    toolCallCount: 3,
    fileChangeCount: 1,
    irreversibleCount: 0,
    approvalCount: 0,
    errorCount: 0,
    promptTokens: 100,
    completionTokens: 50,
    reviewPromptTokens: 0,
    reviewCompletionTokens: 0,
    hasMaterialChange: true,
    triggers: [],
    summary: '完成',
    at: Date.now(),
    ...overrides,
  };
}

/** 20 文件 / 单文件 2000 行的审计快照（diff 全部来自快照，不由磁盘重算）。 */
function bigAudit(fileCount = 20, linesPerFile = 2000): RunAuditResponse {
  const files = Array.from({ length: fileCount }, (_, i) => `src/dir${i % 5}/f${i}.ts`);
  const steps = Array.from({ length: inputStepCount(files.length) }, (_, stepIndex) => {
    const path = files[stepIndex];
    const lines = Array.from({ length: linesPerFile }, (_, i) => `+line ${i} of ${path}`);
    return {
      step: stepIndex + 1,
      checkpointId: `cp_${stepIndex + 1}`,
      toolCallIds: [`call_${stepIndex + 1}`],
      createdAt: Date.now(),
      status: 'active' as const,
      restoredAt: null,
      files: [
        {
          path,
          operation: 'write' as const,
          step: stepIndex + 1,
          checkpointId: `cp_${stepIndex + 1}`,
          toolCallIds: [`call_${stepIndex + 1}`],
          added: linesPerFile,
          removed: 0,
          diff: lines.join('\n'),
          beforeSha256: null,
          afterSha256: 'a'.repeat(64),
        },
      ],
    };
  });
  return {
    runId: 'run-perf',
    report: null,
    budget: null,
    cost: null,
    stages: [],
    approvals: [],
    files: files.map((path, i) => ({
      path,
      steps: [
        {
          step: i + 1,
          checkpointId: `cp_${i + 1}`,
          status: 'active' as const,
          restoredAt: null,
          toolCallIds: [`call_${i + 1}`],
        },
      ],
    })),
    steps,
    fileCount,
    totalBytes: linesPerFile * fileCount * 12,
    undo: { runAvailable: true, activeSnapshots: fileCount },
  };
}

function inputStepCount(fileCount: number): number {
  return fileCount;
}

describe('F：四类状态', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useRunStore.getState().reset();
    useToolCallStore.setState({ byId: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useRunStore.getState().reset();
  });

  it('空态：无 runId 时审计台给出明确引导，运行检视器不空转', () => {
    act(() => root.render(createElement(AuditView, { runId: null })));
    expect(container.textContent).toContain('还没有可审计的运行');
    expect(container.textContent).toContain('有文件改动后');

    act(() => root.render(createElement(RunInspector)));
    expect(container.textContent).toContain('任务开始后，这里显示阶段、成本与风险');
    expect(container.textContent).toContain('尚未开始');
  });

  it('等待态：阶段序列到达后右栏按 aria-live 播报', () => {
    act(() => {
      useRunStore.setState({
        streaming: true,
        acceptedAt: Date.now(),
        stageHistory: [
          { runId: 'run-wait', stage: 'connecting', at: Date.now(), elapsedMs: 0, detail: null },
          { runId: 'run-wait', stage: 'reasoning', at: Date.now(), elapsedMs: 0, detail: null },
        ],
      });
    });
    act(() => root.render(createElement(RunInspector)));
    expect(container.textContent).toContain('阶段序列');
    expect(container.textContent).toContain('连接上游');
    expect(container.textContent).toContain('思考');
    expect(container.querySelector('[aria-label="阶段序列"]')?.getAttribute('aria-live')).toBe('polite');
  });

  it('错误态：汇报卡用红文案，且与「已完成」状态码不同', () => {
    act(() => {
      useRunStore.setState({
        report: report({
          outcome: 'error',
          statusCode: 'RUN_ERROR',
          reason: '上游返回 500',
          summary: '执行出错',
        }),
      });
    });
    act(() => root.render(createElement(RunReportCard)));
    expect(container.textContent).toContain('出错');
    expect(container.querySelector('[data-status-code]')?.getAttribute('data-status-code')).toBe('RUN_ERROR');

    act(() => {
      useRunStore.setState({ report: report({ outcome: 'completed', statusCode: 'RUN_COMPLETED' }) });
    });
    expect(container.querySelector('[data-status-code]')?.getAttribute('data-status-code')).toBe('RUN_COMPLETED');
    expect(container.textContent).toContain('已完成');
  });

  it('冲突态：列文件 / 期望 sha / 实际 sha / 步骤，且为 assertive alert', () => {
    act(() => {
      useRunStore.setState({
        resumeConflict: {
          runId: 'run-conflict',
          conflicts: [
            {
              path: 'src/a.ts',
              expectedSha256: 'deadbeef'.repeat(8),
              actualSha256: 'cafebabe'.repeat(8),
              step: 2,
              checkpointId: 'cp_2',
            },
            {
              path: 'src/b.ts',
              expectedSha256: 'f'.repeat(64),
              actualSha256: null,
              step: 3,
              checkpointId: 'cp_3',
            },
          ],
        },
      });
    });
    act(() => root.render(createElement(ResumeConflictCard)));
    const card = container.querySelector('[data-state="resume-conflict"]');
    expect(card).toBeTruthy();
    expect(card?.getAttribute('role')).toBe('alert');
    expect(card?.getAttribute('aria-live')).toBe('assertive');
    expect(container.textContent).toContain('续跑已阻止');
    expect(container.textContent).toContain('src/a.ts');
    expect(container.textContent).toContain('deadbeef');
    expect(container.textContent).toContain('cafebabe');
    expect(container.textContent).toContain('第 2 步');
    expect(container.textContent).toContain('缺失');
  });
});

describe('F：主视图切换（键盘可达）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useRunStore.getState().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/api/health')) return jsonResponse({ status: 'ok', db: { ok: true }, mcp: { servers: 0, healthy: 0 } });
        if (url.includes('/api/v1/sessions')) return jsonResponse({ items: [], total: 0, limit: 100, offset: 0, hasMore: false });
        if (url.includes('/api/v1/providers')) return jsonResponse({ providers: [], items: [] });
        return jsonResponse({});
      }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useRunStore.getState().reset();
    vi.unstubAllGlobals();
  });

  it('点击「审计台」进入审计视图，aria-pressed 反映当前视图', () => {
    act(() => root.render(createElement(App)));
    const auditBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('审计台'),
    );
    expect(auditBtn).toBeTruthy();
    expect(auditBtn?.getAttribute('aria-pressed')).toBe('false');
    act(() => auditBtn!.click());
    expect(auditBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('还没有可审计的运行');
  });
});

describe('D：审计台渲染边界（2000 行 / 20 文件）', () => {
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

  it('虚拟滚动后 DOM 行有界，文件树 20 项可折叠，且只请求本机 API', async () => {
    const data = bigAudit(20, 2000);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      expect(url.startsWith('/api/')).toBe(true);
      expect(url.startsWith('http')).toBe(false);
      return jsonResponse(data);
    });
    vi.stubGlobal('fetch', fetchMock);

    const t0 = performance.now();
    await act(async () => {
      root.render(createElement(AuditView, { runId: 'run-perf' }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    // 等一次宏任务：组件用 rAF（jsdom 无则退回 setTimeout）记录实测渲染耗时
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const elapsed = performance.now() - t0;

    // 20 个文件全部在树里（折叠按钮 + 文件按钮均为 button，按 aria-current 数文件项）
    const fileButtons = Array.from(container.querySelectorAll('aside[aria-label="文件树"] li button'));
    expect(fileButtons.length).toBe(20);
    // 单文件 2000 行，但可见 DOM 行必须被虚拟滚动截断（viewport 360 / 行高 18 + overscan）
    const visibleRows = container.querySelectorAll('[data-testid="audit-diff-scroll"] > div > div > div');
    expect(visibleRows.length).toBeLessThan(60);
    expect(visibleRows.length).toBeGreaterThan(0);
    // 渲染耗时可读（卡片头显示「渲染 Nms」），并可从 data-render-ms 取实测值
    expect(container.textContent).toContain('渲染');
    const renderMs = Number(container.querySelector('[data-render-ms]')?.getAttribute('data-render-ms'));
    expect(Number.isFinite(renderMs)).toBe(true);
    console.log(`[perf] AuditView 20 文件 / 2000 行：组件实测 ${renderMs}ms，测试端挂载 ${elapsed.toFixed(1)}ms`);
    // 实测数字写进断言消息，跑红时能看到具体值；jsdom 下放宽到 6s 只拦「卡死」
    expect(elapsed, `20 文件 / 2000 行首次渲染 ${elapsed.toFixed(1)}ms`).toBeLessThan(6000);
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});
