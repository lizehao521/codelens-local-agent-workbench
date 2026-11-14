import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AgentInput } from '../src/components/agent/AgentInput';
import { useServerSessionStore } from '../src/stores/serverSessionStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  act(() => {
    useServerSessionStore.setState({ messages: [] });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('AgentInput 下一步推荐', () => {
  it('空闲 700ms 后显示推荐；Tab 只填草稿、不发送', () => {
    const onSend = vi.fn();
    act(() => root.render(createElement(AgentInput, { onSend, onStop: vi.fn(), streaming: false })));
    act(() => vi.advanceTimersByTime(750));
    expect(container.textContent).toContain('下一步：');
    const textarea = container.querySelector('textarea')!;
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(textarea.value).toBe('读取 data 目录并总结内容');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('右方向键同样只填入草稿；Enter 才发送', () => {
    const onSend = vi.fn();
    act(() => root.render(createElement(AgentInput, { onSend, onStop: vi.fn(), streaming: false })));
    act(() => vi.advanceTimersByTime(750));
    const textarea = container.querySelector('textarea')!;
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(textarea.value).toBe('读取 data 目录并总结内容');
    expect(onSend).not.toHaveBeenCalled();
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onSend).toHaveBeenCalledWith('读取 data 目录并总结内容');
  });
});
