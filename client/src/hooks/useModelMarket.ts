// 模型市场 Hook —— 聚合 providers、同步状态，提供搜索/筛选逻辑
// 供 ModelMarket 组件与 ProviderZone 复用

import { useMemo, useState, useCallback } from 'react';
import type { ProviderModel } from '../types';
import { useSettingsStore } from '../stores/settingsStore';

export interface ModelMarketModel extends ProviderModel {
  providerId: string;
  providerName: string;
  providerBaseUrl: string;
}

export interface SyncStatus {
  lastRunAt: number | null;
  lastStatus: string;
  lastError: string | null;
  lastProviderCount: number | null;
  lastModelCount: number | null;
  sourceUrl: string;
}

export interface ProviderStats {
  providerId: string;
  providerName: string;
  modelCount: number;
  nativeToolsCount: number;
  maxContext: number;
  defaultModel: string;
  baseUrl: string;
  hasModels: boolean;
}

export interface FilterState {
  searchQuery: string;
  selectedProviders: string[];
  capabilities: {
    nativeTools: boolean | null;
    retainReasoningContent: boolean | null;
    explicitParallelToolCalls: boolean | null;
  };
  contextWindowRange: [number | null, number | null];
  probeStatus: string | null;
}

const DEFAULT_FILTERS: FilterState = {
  searchQuery: '',
  selectedProviders: [],
  capabilities: {
    nativeTools: null,
    retainReasoningContent: null,
    explicitParallelToolCalls: null,
  },
  contextWindowRange: [null, null],
  probeStatus: null,
};

export function useModelMarket() {
  const providers = useSettingsStore((s) => s.providers);
  const providersLoaded = useSettingsStore((s) => s.providersLoaded);
  const providersLoading = useSettingsStore((s) => s.providersLoading);
  const providersError = useSettingsStore((s) => s.providersError);
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const selectProvider = useSettingsStore((s) => s.selectProvider);
  const refreshProviders = useSettingsStore((s) => s.refreshProviders);

  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);

  // 扁平化所有模型，附带 provider 信息
  const allModels = useMemo((): ModelMarketModel[] => {
    return providers.flatMap((provider) =>
      provider.models.map((model) => ({
        ...model,
        providerId: provider.id,
        providerName: provider.name,
        providerBaseUrl: provider.baseUrl,
      }))
    );
  }, [providers]);

  // 筛选后的模型列表
  const filteredModels = useMemo((): ModelMarketModel[] => {
    return allModels.filter((model) => {
      // 搜索查询（模型名/ID 模糊匹配）
      if (filters.searchQuery) {
        const q = filters.searchQuery.toLowerCase();
        const nameMatch = model.name.toLowerCase().includes(q);
        const idMatch = model.id.toLowerCase().includes(q);
        const providerMatch = model.providerName.toLowerCase().includes(q);
        if (!nameMatch && !idMatch && !providerMatch) return false;
      }

      // Provider 多选筛选
      if (filters.selectedProviders.length > 0) {
        if (!filters.selectedProviders.includes(model.providerId)) return false;
      }

      // 能力筛选
      const caps = model.capabilities;
      if (caps) {
        if (filters.capabilities.nativeTools !== null && caps.nativeTools !== filters.capabilities.nativeTools) {
          return false;
        }
        if (
          filters.capabilities.retainReasoningContent !== null &&
          caps.retainReasoningContent !== filters.capabilities.retainReasoningContent
        ) {
          return false;
        }
        if (
          filters.capabilities.explicitParallelToolCalls !== null &&
          caps.explicitParallelToolCalls !== filters.capabilities.explicitParallelToolCalls
        ) {
          return false;
        }
      } else if (
        filters.capabilities.nativeTools !== null ||
        filters.capabilities.retainReasoningContent !== null ||
        filters.capabilities.explicitParallelToolCalls !== null
      ) {
        // 无能力数据时，若用户勾选了任一能力筛选，则不显示
        return false;
      }

      // 上下文窗口范围筛选
      const ctx = caps?.contextWindow ?? null;
      if (filters.contextWindowRange[0] !== null && (ctx === null || ctx < filters.contextWindowRange[0]!)) {
        return false;
      }
      if (filters.contextWindowRange[1] !== null && (ctx === null || ctx > filters.contextWindowRange[1]!)) {
        return false;
      }

      // 探测状态筛选
      if (filters.probeStatus && model.probeStatus !== filters.probeStatus) {
        return false;
      }

      return true;
    });
  }, [allModels, filters]);

  // 按 Provider 分组（用于卡片化展示）
  const modelsByProvider = useMemo((): Record<string, ModelMarketModel[]> => {
    const grouped: Record<string, ModelMarketModel[]> = {};
    for (const model of filteredModels) {
      if (!grouped[model.providerId]) grouped[model.providerId] = [];
      grouped[model.providerId].push(model);
    }
    return grouped;
  }, [filteredModels]);

  // Provider 统计信息
  const providerStats = useMemo(() => {
    return providers.map((p) => {
      const models = allModels.filter((m) => m.providerId === p.id);
      const nativeToolsCount = models.filter((m) => m.capabilities?.nativeTools === true).length;
      const maxContext = Math.max(...models.map((m) => m.capabilities?.contextWindow ?? 0), 0);
      return {
        providerId: p.id,
        providerName: p.name,
        modelCount: models.length,
        nativeToolsCount,
        maxContext,
        defaultModel: p.defaultModel,
        baseUrl: p.baseUrl,
        hasModels: models.length > 0,
      };
    });
  }, [providers, allModels]);

  // 切换 Provider 并选中模型
  const selectModel = useCallback(
    (model: ModelMarketModel) => {
      if (settings.provider !== model.providerId) {
        selectProvider(model.providerId);
      }
      update({ model: model.id });
    },
    [settings.provider, selectProvider, update]
  );

  // 重置筛选器
  const resetFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
  }, []);

  // 更新单个筛选项
  const updateFilter = useCallback(<K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  // 刷新同步状态
  const refreshSyncStatus = useCallback(async () => {
    setSyncLoading(true);
    try {
      const res = await fetch('/api/v1/providers/sync-status');
      if (res.ok) {
        const data = await res.json();
        setSyncStatus(data.sync);
      }
    } catch {
      setSyncStatus(null);
    } finally {
      setSyncLoading(false);
    }
  }, []);

  // 触发同步刷新
  const triggerSync = useCallback(async () => {
    setSyncLoading(true);
    try {
      await refreshProviders(true);
      await refreshSyncStatus();
    } finally {
      setSyncLoading(false);
    }
  }, [refreshProviders, refreshSyncStatus]);

  return {
    // 数据
    allModels,
    filteredModels,
    modelsByProvider,
    providerStats,
    providers,
    providersLoaded,
    providersLoading,
    providersError,
    syncStatus,
    syncLoading,
    currentProviderId: settings.provider,
    currentModelId: settings.model,

    // 筛选
    filters,
    setFilters,
    updateFilter,
    resetFilters,

    // 动作
    selectModel,
    refreshSyncStatus,
    triggerSync,
    refreshProviders: () => refreshProviders(true),
  };
}