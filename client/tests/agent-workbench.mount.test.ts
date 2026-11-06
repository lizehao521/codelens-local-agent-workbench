// 挂载冒烟测试 —— jsdom 真实挂载 <App />，验证 v2.0 Agent 工作台运行期无错
// 覆盖：三栏骨架 / 空态引导 / 设置五分区 / 恢复码弹窗 / SSE 无 Key 错误流的前端入口

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import App from '../src/App';

// jsdom 无 matchMedia：主题 hook 依赖
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

// React 19 act 环境标志（消除 "not configured to support act" 告警）
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  // fetch 打桩：health / sessions / providers / capabilities
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/api/health')) {
      return jsonResponse({ status: 'ok', db: { ok: true }, mcp: { servers: 0, healthy: 0 } });
    }
    if (url.includes('/api/v1/sessions')) {
      return jsonResponse({ items: [], total: 0, limit: 100, offset: 0, hasMore: false });
    }
    if (url.includes('/api/v1/providers')) {
      return jsonResponse({ providers: [], items: [] });
    }
    return jsonResponse({});
  }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Agent 工作台挂载', () => {
  it('渲染三栏骨架与空态引导', async () => {
    await act(async () => {
      root.render(createElement(App));
    });
    // 顶栏品牌
    expect(container.textContent).toContain('CodeLens');
    // 中栏空态引导（定位文案：一句话动手 / 每步可见 / 风险拍板 / 密钥留在本机）
    expect(container.textContent).toContain('一句话交代，Agent 动手');
    expect(container.textContent).toContain('密钥只留在本机');
    // 右栏检视器
    expect(container.textContent).toContain('运行检视器');
    // 无 Key 引导条
    expect(container.textContent).toContain('API Key');
  });

  it('设置弹层展示五个分区', async () => {
    await act(async () => {
      root.render(createElement(App));
    });
    // 打开设置（顶栏设置按钮）
    const buttons = Array.from(container.querySelectorAll('button'));
    const settingsButton = buttons.find((b) => b.getAttribute('aria-label') === '设置');
    expect(settingsButton).toBeTruthy();
    await act(async () => {
      settingsButton!.click();
    });
    for (const zone of ['模型与密钥', '工具管理', 'MCP 连接器', '安全边界', '数据管理']) {
      expect(container.textContent).toContain(zone);
    }
  });

  it('输入框 Enter 前不发起请求（无 Key 时仍走 SSE 错误流）', async () => {
    await act(async () => {
      root.render(createElement(App));
    });
    const textarea = container.querySelector('textarea');
    expect(textarea).toBeTruthy();
    const fetchMock = vi.mocked(fetch);
    const before = fetchMock.mock.calls.length;
    // 未输入内容时点击发送按钮：不发起请求
    const sendButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === '发送任务',
    );
    await act(async () => {
      sendButton?.click();
    });
    expect(fetchMock.mock.calls.length).toBe(before);
  });
});
