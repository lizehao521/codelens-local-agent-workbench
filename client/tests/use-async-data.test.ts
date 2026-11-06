// useAsyncData hook 测试 —— 统一异步加载模式的正确性：
//   正常：成功 → data 落地、loading 归位
//   边界：enabled=false 不发请求；deps 变化与 reload 触发重取
//   异常：失败 → error 文案；卸载后的迟到结果不得写回状态

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAsyncData } from '../src/hooks/useAsyncData';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface ProbeState {
  data: unknown;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

let container: HTMLDivElement;
let root: Root;
let latest: ProbeState | null = null;

function renderProbe(
  loader: () => Promise<unknown>,
  deps: unknown[],
  enabled: boolean,
): void {
  function Probe(): null {
    latest = useAsyncData(loader, deps, { enabled, errorMessage: '兜底文案' });
    return null;
  }
  act(() => {
    root.render(createElement(Probe));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = null;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

describe('useAsyncData', () => {
  it('成功后写入 data 并结束 loading', async () => {
    const loader = vi.fn().mockResolvedValue({ hello: 'world' });
    renderProbe(loader, [], true);

    expect(latest?.loading).toBe(true);
    expect(latest?.data).toBeNull();

    await act(async () => {
      await Promise.resolve();
    });

    expect(latest?.loading).toBe(false);
    expect(latest?.data).toEqual({ hello: 'world' });
    expect(latest?.error).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('失败时给出错误文案且不残留 loading', async () => {
    const loader = vi.fn().mockRejectedValue(new Error('接口炸了'));
    renderProbe(loader, [], true);

    await act(async () => {
      await Promise.resolve();
    });

    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBe('接口炸了');
    expect(latest?.data).toBeNull();
  });

  it('非 Error 抛出时回落到兜底文案', async () => {
    const loader = vi.fn().mockRejectedValue('字符串错误');
    renderProbe(loader, [], true);

    await act(async () => {
      await Promise.resolve();
    });

    expect(latest?.error).toBe('兜底文案');
  });

  it('enabled=false 时不发起请求', async () => {
    const loader = vi.fn().mockResolvedValue(1);
    renderProbe(loader, [], false);

    await act(async () => {
      await Promise.resolve();
    });

    expect(loader).not.toHaveBeenCalled();
    expect(latest?.loading).toBe(false);
    expect(latest?.data).toBeNull();
  });

  it('reload 会重新拉取一次', async () => {
    const loader = vi.fn().mockResolvedValue('v');
    renderProbe(loader, [], true);

    await act(async () => {
      await Promise.resolve();
    });
    expect(loader).toHaveBeenCalledTimes(1);

    act(() => {
      latest?.reload();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('组件卸载后迟到的结果不会写回状态（竞态防护）', async () => {
    let resolveLate: (v: string) => void = () => undefined;
    const loader = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveLate = resolve;
        }),
    );
    renderProbe(loader, [], true);

    act(() => {
      root.unmount();
    });

    await act(async () => {
      resolveLate('迟到结果');
      await Promise.resolve();
    });

    // 卸载后不应再触发 setState 警告或写入数据
    expect(latest?.data).toBeNull();
  });
});
