// R3：等待态界面回归——阶段文案、每秒计时、10s 慢响应升级、中止入口。
// 断言只做可观察行为（文案 / data-stage / 按钮回调），不做实现细节耦合。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RunStageBanner } from '../src/components/agent/RunStageBanner';
import { useRunStore } from '../src/stores/runStore';
import type { AgentStagePayload } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function stagePayload(stage: AgentStagePayload['stage'], elapsedMs = 0): AgentStagePayload {
  return { runId: 'run-test', stage, at: Date.now(), elapsedMs, detail: null };
}

describe('RunStageBanner（R3 等待态）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useRunStore.getState().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useRunStore.getState().reset();
  });

  function render(onAbort: () => void = () => {}): string {
    act(() => root.render(createElement(RunStageBanner, { onAbort })));
    return container.textContent ?? '';
  }

  it('收到 connecting 早事件即显示「正在连接模型…」与已等待计时', () => {
    act(() => {
      useRunStore.setState({
        streaming: true,
        acceptedAt: Date.now(),
        stage: stagePayload('connecting'),
      });
    });
    const text = render();
    expect(text).toContain('正在连接模型');
    expect(text).toContain('已等待');
    expect(container.querySelector('[data-testid="run-stage-banner"]')?.getAttribute('data-stage')).toBe(
      'connecting',
    );
  });

  it('等待超过 10s 升级为「上游响应较慢」提示（不是假进度条）', () => {
    act(() => {
      useRunStore.setState({
        streaming: true,
        acceptedAt: Date.now() - 12_000,
        stage: stagePayload('connecting', 12_000),
      });
    });
    const text = render();
    expect(text).toContain('上游响应较慢');
    expect(text).toContain('中止');
  });

  it('阶段推进到 content 后文案切到「正在输出…」，慢响应提示不再出现', () => {
    act(() => {
      useRunStore.setState({
        streaming: true,
        acceptedAt: Date.now() - 12_000,
        stage: stagePayload('content', 12_000),
      });
    });
    const text = render();
    expect(text).toContain('正在输出');
    expect(text).not.toContain('上游响应较慢');
  });

  it('终局阶段可区分：upstream_timeout 显示超时文案', () => {
    act(() => {
      useRunStore.setState({
        streaming: true,
        acceptedAt: Date.now() - 3_000,
        stage: { ...stagePayload('upstream_timeout', 3_000), detail: '上游在 60s 内没有响应' },
      });
    });
    const text = render();
    expect(text).toContain('上游响应超时');
  });

  it('中止按钮可点击并触发回调', () => {
    const onAbort = vi.fn();
    act(() => {
      useRunStore.setState({
        streaming: true,
        acceptedAt: Date.now(),
        stage: stagePayload('connecting'),
      });
    });
    render(onAbort);
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('中止'));
    expect(button).toBeDefined();
    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('非流式状态不渲染等待条（不占位、不留残影）', () => {
    const text = render();
    expect(text).toBe('');
    expect(container.querySelector('[data-testid="run-stage-banner"]')).toBeNull();
  });
});
