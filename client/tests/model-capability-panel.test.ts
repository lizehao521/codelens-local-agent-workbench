// 模型能力面板渲染测试 —— 从 /providers 目录动态渲染能力标签 / 调用限制 / 能力开关
// 对应设计：docs/design/model-capability-design.md §2 §3 §4

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { ModelCapabilityPanel } from '../src/components/settings/ModelCapabilityPanel';
import { useSettingsStore } from '../src/stores/settingsStore';
import type { Provider } from '../src/types';

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FULL_PROVIDER: Provider = {
  id: 'relay',
  name: 'OpenAI 兼容上游',
  baseUrl: 'https://relay.example/v1',
  defaultModel: 'm-full',
  docsUrl: '',
  models: [
    {
      id: 'm-full',
      name: '满配模型',
      capabilities: {
        nativeTools: true,
        toolChoiceValues: ['auto', 'none', 'required', 'named'],
        contextWindow: 65536,
        retainReasoningContent: true,
        requireToolStreamFlag: false,
        explicitParallelToolCalls: true,
      },
      limits: { maxOutputTokens: 8192, rateLimitRpm: 60, rateLimitTpm: null, maxConcurrent: 4 },
      probeStatus: 'supported',
    },
    {
      id: 'm-lite',
      name: '解析模型',
      capabilities: {
        nativeTools: false,
        toolChoiceValues: ['auto', 'none'],
        contextWindow: 32000,
        retainReasoningContent: false,
        requireToolStreamFlag: false,
        explicitParallelToolCalls: false,
      },
      limits: { maxOutputTokens: null, rateLimitRpm: null, rateLimitTpm: null, maxConcurrent: null },
      probeStatus: 'unsupported',
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

function mountWith(modelId: string, overrides: Record<string, unknown> = {}): void {
  useSettingsStore.setState({
    providers: [FULL_PROVIDER],
    providersLoaded: true,
    providersLoading: false,
    providersError: null,
    settings: { ...useSettingsStore.getState().settings, provider: 'relay', model: modelId },
    ...overrides,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(ModelCapabilityPanel));
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ sync: { lastStatus: 'success', lastModelCount: 39, lastRunAt: 1 }, recentLogs: [] }),
  })) as unknown as typeof fetch);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

describe('ModelCapabilityPanel —— 能力标签与调用限制', () => {
  it('满配模型渲染能力标签 + 调用限制度量', () => {
    mountWith('m-full');
    const text = container.textContent ?? '';
    expect(text).toContain('原生工具');
    expect(text).toContain('保留推理');
    expect(text).toContain('并行工具');
    expect(text).toContain('上下文 66K');
    // 限制度量
    expect(text).toContain('调用限制');
    expect(text).toContain('输出上限');
    expect(text).toContain('req/min');
    // rateLimitTpm=null → 未标注
    expect(text).toContain('未标注');
  });

  it('无能力数据（nativeTools=false）显示「提示词解析」标签', () => {
    mountWith('m-lite');
    const text = container.textContent ?? '';
    expect(text).toContain('提示词解析');
    // 全未标注的限制
    expect(text).toContain('上游未声明限速');
  });

  it('nativeTools=false 时「原生工具」通道开关被禁用', () => {
    mountWith('m-lite');
    const buttons = Array.from(container.querySelectorAll('button'));
    const nativeBtn = buttons.find((b) => b.textContent?.trim() === '原生工具');
    expect(nativeBtn).toBeTruthy();
    expect(nativeBtn?.hasAttribute('disabled')).toBe(true);
  });

  it('nativeTools=true 时「原生工具」通道开关可用', () => {
    mountWith('m-full');
    const buttons = Array.from(container.querySelectorAll('button'));
    const nativeBtn = buttons.find((b) => b.textContent?.trim() === '原生工具');
    expect(nativeBtn).toBeTruthy();
    expect(nativeBtn?.hasAttribute('disabled')).toBe(false);
  });
});

describe('ModelCapabilityPanel —— 状态反馈', () => {
  it('拉取失败显示异常条 + 重试（降级不空白）', () => {
    mountWith('m-full', { providersError: '网络错误' });
    const text = container.textContent ?? '';
    expect(text).toContain('模型目录加载失败');
    expect(text).toContain('重试');
  });

  it('加载中显示骨架（providersLoading 且未就绪）', () => {
    mountWith('m-full', { providersLoaded: false, providersLoading: true });
    const skeletons = container.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
    expect(container.textContent ?? '').toContain('正在加载模型目录');
  });
});

describe('ModelCapabilityPanel —— custom 手填态的同源引导', () => {
  const CUSTOM_PROVIDER: Provider = {
    id: 'custom',
    name: '自定义 Provider',
    baseUrl: '',
    defaultModel: '',
    docsUrl: '',
    models: [],
  };

  it('custom 的 Base URL 与已同步 provider 同源时，提示可切换并给出模型数', () => {
    mountWith('', {
      providers: [FULL_PROVIDER, CUSTOM_PROVIDER],
      settings: {
        ...useSettingsStore.getState().settings,
        provider: 'custom',
        model: 'deepseek-v4-pro',
        customBaseUrl: 'https://relay.example/v1',
      },
    });
    const text = container.textContent ?? '';
    expect(text).toContain('已同步为');
    expect(text).toContain('OpenAI 兼容上游');
    expect(text).toContain('2 个模型');
    expect(text).toContain('切换');
  });

  it('点击「切换」后当前 provider 变为已同步 provider（模型可下拉选择）', () => {
    mountWith('', {
      providers: [FULL_PROVIDER, CUSTOM_PROVIDER],
      settings: {
        ...useSettingsStore.getState().settings,
        provider: 'custom',
        model: '',
        customBaseUrl: 'https://relay.example/v1',
      },
    });
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === '切换');
    expect(btn).toBeTruthy();
    act(() => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useSettingsStore.getState().settings.provider).toBe('relay');
    expect(useSettingsStore.getState().settings.model).toBe('m-full');
  });

  it('Base URL 不同源时不显示切换提示（避免误导）', () => {
    mountWith('', {
      providers: [FULL_PROVIDER, CUSTOM_PROVIDER],
      settings: {
        ...useSettingsStore.getState().settings,
        provider: 'custom',
        model: 'x',
        customBaseUrl: 'https://other.example/v1',
      },
    });
    expect(container.textContent ?? '').not.toContain('已同步为');
  });

  it('同源判定忽略尾斜杠与误填的 endpoint 后缀', () => {
    mountWith('', {
      providers: [FULL_PROVIDER, CUSTOM_PROVIDER],
      settings: {
        ...useSettingsStore.getState().settings,
        provider: 'custom',
        model: 'x',
        customBaseUrl: 'https://relay.example/v1/chat/completions',
      },
    });
    expect(container.textContent ?? '').toContain('已同步为');
  });
});
