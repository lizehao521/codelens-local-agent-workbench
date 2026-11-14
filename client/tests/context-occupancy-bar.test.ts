// ContextOccupancyBar 判据（AC-11）—— 上下文占用条的读数口径与五态。
//
// 为什么单独立一份：这条 bar 是人判断「还能不能继续跑」的唯一依据。它最危险的
// 坏法不是不显示，而是**在窗口未知时瞎猜一个百分比**，或把 0 token 画成有占用 ——
// 那会让人在错误的时机手动压缩，或在该压缩时毫无警觉。
//
// 阈值口径钉死为 >=（75 琥珀 / 88 警示），与服务端 COMPACTION_THRESHOLD=0.75
// 的严格 > 刻意不同：恰好 75% 时服务端还不压缩，前端先给预警。这层差异是有意的，
// 判据把它钉住，避免后来者「对齐服务端」时把预警边界悄悄挪掉。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ContextOccupancyBar } from '../src/components/agent/ContextOccupancyBar';
import { useRunStore, type RunMeta } from '../src/stores/runStore';
import { useServerSessionStore } from '../src/stores/serverSessionStore';
import type { SessionMessageRow } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function meta(over: Partial<RunMeta> = {}): RunMeta {
  return {
    sessionId: 's-1',
    provider: 'p',
    model: 'm',
    channel: 'native',
    degraded: false,
    degradedReason: null,
    iteration: 1,
    maxIterations: 8,
    ...over,
  };
}

function msg(tokens: number, id: string): SessionMessageRow {
  return { id, seq: 1, role: 'user', content: 'x', segments: null, tokens, isSummary: false, createdAt: 0 };
}

function render(m: RunMeta | null, messages: SessionMessageRow[] = []): void {
  // store 写入也要在 act 内：组件已挂载时二次 render 会由 setState 触发一次
  // 独立更新，落在 act 外就是「not wrapped in act」警告的来源。
  act(() => {
    useRunStore.setState({ meta: m });
    useServerSessionStore.setState({ messages });
    root.render(createElement(ContextOccupancyBar));
  });
}

const bar = (): HTMLElement => {
  const el = document.querySelector('[role="progressbar"]');
  expect(el, '占用条必须带 role=progressbar').toBeTruthy();
  return el as HTMLElement;
};
const fill = (): HTMLElement => bar().firstElementChild as HTMLElement;
const body = (): string => document.body.textContent ?? '';
const percent = (): number => Number(bar().getAttribute('aria-valuenow'));

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useRunStore.setState({ meta: null });
  useServerSessionStore.setState({ messages: [] });
});

describe('窗口未知时不得瞎猜（degraded / empty 态）', () => {
  it('meta 未到且无消息：0%，不显示窗口分母', () => {
    render(null);
    expect(percent()).toBe(0);
    expect(body()).toContain('（0%）');
    expect(body()).not.toContain('/');
  });

  it('有本地 token 但窗口未知：仍是 0%，不得编一个窗口出来', () => {
    render(null, [msg(5000, 'm1')]);
    expect(percent()).toBe(0);
    expect(body()).toContain('5.0k');
    expect(body()).not.toContain('/');
  });

  it('meta 到了但 contextWindow 缺失：同样 0%', () => {
    render(meta({ estimatedPromptTokens: 9000 }));
    expect(percent()).toBe(0);
    expect(body()).not.toContain('/');
  });

  it('window 为 0 或负数：按未知处理，不得除零得出 Infinity', () => {
    render(meta({ contextWindow: 0, estimatedPromptTokens: 100 }));
    expect(percent()).toBe(0);
    render(meta({ contextWindow: -1, estimatedPromptTokens: 100 }));
    expect(percent()).toBe(0);
  });
});

describe('数据源优先级：meta 权威，本地消息只兜底', () => {
  it('meta 与本地消息同时存在时用 meta', () => {
    render(meta({ contextWindow: 1000, estimatedPromptTokens: 500 }), [msg(900, 'm1')]);
    expect(percent()).toBe(50);
    expect(body()).toContain('500 / 1.0k');
  });

  it('meta 无 estimatedPromptTokens 时退回本地消息之和', () => {
    render(meta({ contextWindow: 1000 }), [msg(200, 'm1'), msg(100, 'm2')]);
    expect(percent()).toBe(30);
  });

  it('本地兜底是多条求和，不是取最后一条', () => {
    render(null, [msg(100, 'm1'), msg(200, 'm2'), msg(300, 'm3')]);
    expect(body()).toContain('600');
  });
});

describe('阈值边界（>=75 琥珀 / >=88 警示）', () => {
  const at = (pct: number): void => {
    render(meta({ contextWindow: 1000, estimatedPromptTokens: pct * 10 }));
  };

  it('74%：正常态，不出预警文案', () => {
    at(74);
    expect(percent()).toBe(74);
    expect(fill().className).toContain('bg-accent');
    expect(body()).not.toContain('占用偏高');
    expect(body()).not.toContain('接近上限');
  });

  it('恰好 75%：琥珀预警（前端比服务端早一步）', () => {
    at(75);
    expect(fill().className).toContain('bg-warning');
    expect(body()).toContain('占用偏高');
    expect(body()).not.toContain('接近上限');
  });

  it('87%：仍是琥珀，不得提前进警示', () => {
    at(87);
    expect(fill().className).toContain('bg-warning');
    expect(body()).not.toContain('接近上限');
  });

  it('恰好 88%：警示，并说清后果是触发压缩', () => {
    at(88);
    expect(fill().className).toContain('bg-danger');
    expect(body()).toContain('接近上限，将触发压缩');
    expect(body()).not.toContain('占用偏高');
  });

  it('超过 100%：截到 100，进度条不得溢出', () => {
    render(meta({ contextWindow: 1000, estimatedPromptTokens: 5000 }));
    expect(percent()).toBe(100);
    expect(fill().style.width).toBe('100%');
  });
});

describe('可核实事实与可访问性', () => {
  it('0 token：宽度为 0，不画一条假占用', () => {
    render(meta({ contextWindow: 1000, estimatedPromptTokens: 0 }));
    expect(percent()).toBe(0);
    expect(fill().style.width).toBe('0%');
  });

  it('极小占用：至少 1% 且宽度不低于 2%，避免有 token 却看不见', () => {
    render(meta({ contextWindow: 1_000_000, estimatedPromptTokens: 10 }));
    expect(percent()).toBe(1);
    expect(fill().style.width).toBe('2%');
  });

  it('aria 三件套齐全且 valuenow 与显示百分比一致', () => {
    render(meta({ contextWindow: 1000, estimatedPromptTokens: 880 }));
    expect(bar().getAttribute('aria-valuemin')).toBe('0');
    expect(bar().getAttribute('aria-valuemax')).toBe('100');
    expect(bar().getAttribute('aria-label')).toBe('上下文占用');
    expect(percent()).toBe(88);
    expect(body()).toContain('（88%）');
  });
});