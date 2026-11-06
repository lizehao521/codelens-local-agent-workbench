// 统一「打开面板 → 拉数据 → 渲染 / 报错」的模式。
//
// 此前 JudgePanelModal / ToolSkillModal / McpZone / ToolsZone /
// SandboxPermissionModal 各自复制了同一段样板：useState × 3 + useEffect +
// `let alive = true` 竞态标志 + then/catch/finally 分支（约 40 行 × 5 处）。
// 复制粘贴的代价是：竞态处理一旦要改（比如换成 AbortController），要改五处，
// 漏一处就会出现「面板关闭后 setState」的告警。
//
// 这里收敛成一个 hook，语义固定为：
//   · 依赖变化或 reload() 触发时重新拉取；
//   · 卸载 / 依赖再次变化后，迟到的结果一律丢弃（不 setState）；
//   · 错误统一转成可展示的字符串，调用方不必再写 instanceof 判断。

import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncDataState<T> {
  /** 最近一次成功的数据；未成功过为 null。 */
  data: T | null;
  /** 失败原因（可展示的文本）；无错误为 null。 */
  error: string | null;
  /** 是否正在拉取（含首次加载与刷新）。 */
  loading: boolean;
  /** 手动重新拉取。 */
  reload: () => void;
}

/**
 * @param loader   拉取函数；每次调用都应返回可 abort 的 Promise 或忽略迟到结果。
 * @param deps     依赖列表，语义与 useEffect 一致（深比较浅层引用）。
 * @param options  enabled=false 时不发起请求（面板未打开时用）；
 *                 errorMessage 用于兜底文案（loader 抛非 Error 时使用）；
 *                 onError 用于把错误交给调用方处理（设置区习惯弹 toast，
 *                 而弹窗习惯在面板内显示错误条 —— 两种表达方式共用同一个 hook）。
 */
export function useAsyncData<T>(
  loader: () => Promise<T>,
  deps: React.DependencyList,
  options?: { enabled?: boolean; errorMessage?: string; onError?: (message: string) => void },
): AsyncDataState<T> {
  const enabled = options?.enabled ?? true;
  const fallbackMessage = options?.errorMessage ?? '加载失败';
  const onError = options?.onError;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 初始 loading 跟随 enabled：面板「一打开就在加载」是常态，
  // 若初始恒为 false，首帧会先渲染一帧空数据再切到 loading（可见的闪烁）。
  const [loading, setLoading] = useState(enabled);
  const [nonce, setNonce] = useState(0);

  // loader 每次渲染都是新函数，用 ref 兜住，避免把它放进依赖导致无限重取。
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  // onError 同理：调用方多半传内联箭头函数，放进依赖会导致每次渲染都重取。
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((result) => {
        if (cancelled) return;
        setData(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : fallbackMessage;
        setError(message);
        onErrorRef.current?.(message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nonce, ...deps]);

  return { data, error, loading, reload };
}
