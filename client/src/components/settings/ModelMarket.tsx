// 模型市场 —— 全量模型浏览、搜索、筛选、一键选中
// 复用 useModelMarket hook 聚合 providers、同步状态、筛选逻辑

import { useState } from 'react';
import {
  Search,
  Filter,
  X,
  RefreshCw,
  Zap,
  Sparkles,
  Layers,
  Cpu,
  Gauge,
  Globe,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from 'lucide-react';
import { useModelMarket, type FilterState, type SyncStatus, type ProviderStats } from '../../hooks/useModelMarket';
import { Dropdown, Field } from './FormControls';
import { cn } from '../../lib/cn';

const CAPABILITY_OPTIONS = [
  { key: 'nativeTools', label: '原生工具', icon: Zap },
  { key: 'retainReasoningContent', label: '保留推理', icon: Sparkles },
  { key: 'explicitParallelToolCalls', label: '并行工具', icon: Layers },
] as const;

function fmtCount(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : new Intl.NumberFormat('zh-CN').format(n);
}

function Badge({ tone, children, icon: Icon }: { tone: 'ok' | 'warn' | 'muted'; children: React.ReactNode; icon?: React.ComponentType<{ size?: number }> }) {
  return (
    <span
      className={cn(
        'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
        tone === 'ok' && 'border-success bg-success-subtle text-success',
        tone === 'warn' && 'border-warning bg-warning-subtle text-warning',
        tone === 'muted' && 'border-border text-text-secondary',
      )}
    >
      {Icon && <Icon size={10} />}
      {children}
    </span>
  );
}

function ModelCard({
  model,
  isSelected,
  onSelect,
  probeStatus,
}: {
  model: ReturnType<typeof useModelMarket>['allModels'][0];
  isSelected: boolean;
  onSelect: () => void;
  probeStatus: string | null;
}) {
  const caps = model.capabilities;
  const limits = model.limits;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative flex flex-col gap-2 rounded-md border p-2.5 text-left transition-all duration-150',
        isSelected
          ? 'border-accent bg-accent-subtle ring-1 ring-accent'
          : 'border-border bg-bg-primary hover:border-accent hover:bg-bg-secondary',
      )}
    >
      {isSelected && (
        <span className="absolute right-2 top-2 flex items-center gap-1 text-xs text-accent">
          <Check size={11} /> 已选中
        </span>
      )}

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-text-primary truncate">
            <span className="truncate">{model.name}</span>
            <span className="shrink-0 text-xs text-text-tertiary font-mono">{model.id}</span>
          </div>
          <span className="text-[11px] text-text-tertiary">
            {model.providerName} · {model.providerBaseUrl || '默认地址'}
          </span>
        </div>
      </div>

      {/* 能力徽标 */}
      {caps && (
        <div className="flex flex-wrap items-center gap-1">
          {caps.nativeTools && <Badge tone="ok" icon={Zap}>原生工具</Badge>}
          {caps.retainReasoningContent && <Badge tone="muted" icon={Sparkles}>保留推理</Badge>}
          {caps.explicitParallelToolCalls && <Badge tone="muted" icon={Layers}>并行工具</Badge>}
          {caps.contextWindow && <Badge tone="muted" icon={Cpu}>上下文 {fmtCount(caps.contextWindow)}</Badge>}
          {caps.requireToolStreamFlag && <Badge tone="warn">需 tool_stream</Badge>}
        </div>
      )}

      {/* 限速信息 */}
      {limits && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-text-tertiary">
          {limits.maxOutputTokens !== null && <Badge tone="muted" icon={Gauge}>输出 {fmtCount(limits.maxOutputTokens)}</Badge>}
          {limits.rateLimitRpm !== null && <Badge tone="muted">频率 {fmtCount(limits.rateLimitRpm)}/min</Badge>}
          {limits.maxConcurrent !== null && <Badge tone="muted">并发 {limits.maxConcurrent}</Badge>}
        </div>
      )}

      {/* 探测状态 & 同步来源 */}
      <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
        {probeStatus && (
          <Badge
            tone={probeStatus === 'supported' ? 'ok' : probeStatus === 'unsupported' ? 'warn' : 'muted'}
          >
            {probeStatus === 'supported' ? '探测通过' : probeStatus === 'unsupported' ? '不支持原生' : probeStatus}
          </Badge>
        )}
        <span className="flex items-center gap-0.5">
          <Globe size={10} /> {model.providerName}
        </span>
      </div>
    </button>
  );
}

function ProviderCard({
  stats,
  models,
  currentProviderId,
  currentModelId,
  onSelectModel,
}: {
  stats: ProviderStats;
  models: ReturnType<typeof useModelMarket>['allModels'][0][];
  currentProviderId: string;
  currentModelId: string;
  onSelectModel: (model: ReturnType<typeof useModelMarket>['allModels'][0]) => void;
}) {
  const isCurrent = currentProviderId === stats.providerId;
  const nativeToolsCount = models.filter((m) => m.capabilities?.nativeTools === true).length;

  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-colors duration-150',
        isCurrent ? 'border-accent bg-accent-subtle' : 'border-border bg-bg-primary',
      )}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-text-primary">{stats.providerName}</span>
          {stats.baseUrl && (
            <a
              href={stats.baseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-text-tertiary hover:text-accent flex items-center gap-0.5"
            >
              <ExternalLink size={10} /> 文档
            </a>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
          <Badge tone="muted">{stats.modelCount} 模型</Badge>
          {nativeToolsCount > 0 && <Badge tone="ok" icon={Zap}>{nativeToolsCount} 原生</Badge>}
          {stats.maxContext > 0 && <Badge tone="muted" icon={Cpu}>最大 {fmtCount(stats.maxContext)}</Badge>}
        </div>
      </div>

      {/* 默认模型 */}
      {stats.defaultModel && (
        <div className="mb-2 text-[11px] text-text-tertiary">
          默认：<span className="font-mono text-text-secondary">{stats.defaultModel}</span>
        </div>
      )}

      {/* 模型网格 */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {models.slice(0, 12).map((model) => (
          <ModelCard
            key={model.id}
            model={model}
            isSelected={currentProviderId === model.providerId && currentModelId === model.id}
            onSelect={() => onSelectModel(model)}
            probeStatus={model.probeStatus ?? null}
          />
        ))}
        {models.length > 12 && (
          <div className="col-span-full text-center text-xs text-text-tertiary py-2">
            共 {models.length} 个模型，显示前 12 个
          </div>
        )}
      </div>
    </div>
  );
}

function FilterPanel({
  filters,
  providerStats,
  updateFilter,
  resetFilters,
}: {
  filters: FilterState;
  providerStats: ProviderStats[];
  updateFilter: (key: keyof FilterState, value: FilterState[keyof FilterState]) => void;
  resetFilters: () => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="rounded-md border border-border bg-bg-secondary p-3">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-sm font-medium text-text-secondary mb-2"
      >
        <Filter size={14} /> 筛选器
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        <span className="ml-auto text-[11px] text-text-tertiary">
          {filters.searchQuery || filters.selectedProviders.length || filters.probeStatus ||
            filters.capabilities.nativeTools !== null ||
            filters.capabilities.retainReasoningContent !== null ||
            filters.capabilities.explicitParallelToolCalls !== null ||
            filters.contextWindowRange[0] !== null ||
            filters.contextWindowRange[1] !== null
            ? '已筛选'
            : '全部'}
        </span>
      </button>

      {!expanded && <button type="button" onClick={resetFilters} className="text-xs underline text-text-secondary">重置筛选</button>}

      {expanded && (
        <div className="space-y-3">
          {/* 搜索框 */}
          <Field label="搜索" hint="模型名称 / ID / Provider">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-text-tertiary" />
              <input
                value={filters.searchQuery}
                onChange={(e) => updateFilter('searchQuery', e.target.value)}
                placeholder="搜索模型..."
                className="w-full rounded-md border border-border bg-bg-primary pl-8 pr-2.5 py-1.5 text-base text-text-primary focus:border-accent"
              />
            </div>
          </Field>

          {/* Provider 多选 */}
          <Field label="Provider" hint="可多选">
            <div className="flex flex-wrap gap-1.5">
              {providerStats.map((p) => (
                <label key={p.providerId} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={filters.selectedProviders.includes(p.providerId)}
                    onChange={(e) =>
                      updateFilter(
                        'selectedProviders',
                        e.target.checked
                          ? [...filters.selectedProviders, p.providerId]
                          : filters.selectedProviders.filter((id) => id !== p.providerId),
                      )
                    }
                    className="rounded border-border text-accent focus:ring-accent"
                  />
                  <span className="text-sm text-text-primary">{p.providerName}</span>
                  <span className="text-[11px] text-text-tertiary">({p.modelCount})</span>
                </label>
              ))}
            </div>
          </Field>

          {/* 能力筛选 */}
          <Field label="能力" hint="勾选表示必须具备该能力">
            <div className="flex flex-wrap gap-1.5">
              {CAPABILITY_OPTIONS.map(({ key, label, icon: Icon }) => (
                <label key={key} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={filters.capabilities[key as keyof typeof filters.capabilities] === true}
                    onChange={(e) =>
                      updateFilter('capabilities', {
                        ...filters.capabilities,
                        [key]: e.target.checked ? true : null,
                      })
                    }
                    className="rounded border-border text-accent focus:ring-accent"
                  />
                  <span className="flex items-center gap-1 text-sm text-text-primary">
                    <Icon size={12} /> {label}
                  </span>
                </label>
              ))}
            </div>
          </Field>

          {/* 上下文窗口范围 */}
          <Field label="上下文窗口" hint="最小/最大 token 数">
            <div className="flex items-center gap-2">
              <input
                type="number"
                placeholder="最小"
                value={filters.contextWindowRange[0] ?? ''}
                onChange={(e) => updateFilter('contextWindowRange', [e.target.value ? parseInt(e.target.value) : null, filters.contextWindowRange[1]])}
                className="w-24 rounded-md border border-border bg-bg-primary px-2 py-1.5 text-base text-text-primary focus:border-accent"
              />
              <span className="text-text-tertiary">~</span>
              <input
                type="number"
                placeholder="最大"
                value={filters.contextWindowRange[1] ?? ''}
                onChange={(e) => updateFilter('contextWindowRange', [filters.contextWindowRange[0], e.target.value ? parseInt(e.target.value) : null])}
                className="w-24 rounded-md border border-border bg-bg-primary px-2 py-1.5 text-base text-text-primary focus:border-accent"
              />
            </div>
          </Field>

          {/* 探测状态 */}
          <Field label="探测状态">
            <Dropdown
              value={filters.probeStatus ?? ''}
              onChange={(v) => updateFilter('probeStatus', v || null)}
              options={[
                { value: '', label: '全部' },
                { value: 'supported', label: '支持原生' },
                { value: 'unsupported', label: '不支持原生' },
                { value: 'failed', label: '探测失败' },
                { value: 'unknown', label: '未探测' },
              ]}
            />
          </Field>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={resetFilters}
              className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:border-accent hover:text-accent"
            >
              <X size={13} className="mr-1" /> 重置筛选
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SyncStatusCard({
  syncStatus,
  syncLoading,
  triggerSync,
  refreshSyncStatus,
}: {
  syncStatus: SyncStatus | null;
  syncLoading: boolean;
  triggerSync: () => void;
  refreshSyncStatus: () => void;
}) {
  if (!syncStatus) return null;

  const statusTones: Record<string, 'ok' | 'warn' | 'muted'> = {
    success: 'ok',
    failed: 'warn',
    disabled: 'muted',
    error: 'warn',
  };

  return (
    <div className="rounded-md border border-border bg-bg-secondary p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5">
          <Globe size={14} className="text-text-secondary" />
          <span className="text-sm font-medium text-text-primary">上游模型同步状态</span>
          <Badge tone={statusTones[syncStatus.lastStatus] ?? 'muted'}>
            {syncStatus.lastStatus === 'success' ? '成功' : syncStatus.lastStatus === 'failed' ? '失败' : syncStatus.lastStatus === 'disabled' ? '已禁用' : '进行中'}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={refreshSyncStatus}
            disabled={syncLoading}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-text-secondary hover:border-accent hover:text-accent disabled:opacity-50"
          >
            <RefreshCw size={11} className={cn(syncLoading && 'animate-spin')} /> 刷新状态
          </button>
          <button
            type="button"
            onClick={triggerSync}
            disabled={syncLoading}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-text-secondary hover:border-accent hover:text-accent disabled:opacity-50"
          >
            <RefreshCw size={11} /> 触发同步
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <span className="text-text-tertiary">最后同步</span>
          <div className="text-text-primary font-mono">
            {syncStatus.lastRunAt ? new Date(syncStatus.lastRunAt).toLocaleString('zh-CN') : '—'}
          </div>
        </div>
        <div>
          <span className="text-text-tertiary">模型总数</span>
          <div className="text-text-primary font-medium">{syncStatus.lastModelCount ?? 0}</div>
        </div>
        <div>
          <span className="text-text-tertiary">Provider 数</span>
          <div className="text-text-primary font-medium">{syncStatus.lastProviderCount ?? 0}</div>
        </div>
        <div>
          <span className="text-text-tertiary">数据源</span>
          <div className="text-text-tertiary truncate font-mono text-[11px]" title={syncStatus.sourceUrl}>
            {syncStatus.sourceUrl || '—'}
          </div>
        </div>
        {syncStatus.lastError && (
          <div className="col-span-2">
            <span className="text-text-tertiary">错误信息</span>
            <div className="text-danger text-sm break-words">{syncStatus.lastError}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ModelMarket() {
  const {
    // 数据
    filteredModels,
    modelsByProvider,
    providerStats,
    providersLoaded,
    providersLoading,
    providersError,
    syncStatus,
    syncLoading,
    currentProviderId,
    currentModelId,
    // 筛选
    filters,
    updateFilter,
    resetFilters,
    // 动作
    selectModel,
    triggerSync,
    refreshSyncStatus,
    refreshProviders,
  } = useModelMarket();

  return (
    <div className="space-y-4">
      {/* 同步状态卡 */}
      <SyncStatusCard
        syncStatus={syncStatus}
        syncLoading={syncLoading}
        triggerSync={triggerSync}
        refreshSyncStatus={refreshSyncStatus}
      />

      {/* 错误提示 */}
      {providersError && (
        <div className="flex items-center gap-2 rounded-md border border-danger bg-danger-subtle px-2.5 py-1.5 text-xs text-danger">
          <span>模型目录加载失败：{providersError}</span>
          <button
            type="button"
            onClick={() => refreshProviders()}
            className="shrink-0 rounded border border-danger px-2 py-0.5 hover:bg-danger-subtle"
          >
            重试
          </button>
        </div>
      )}

      {/* 加载中 */}
      {providersLoading && !providersLoaded && (
        <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
          <span className="animate-spin">⟳</span> 正在加载模型目录…
        </div>
      )}

      {/* 筛选器 */}
      <FilterPanel
        filters={filters}
        providerStats={providerStats}
        updateFilter={updateFilter}
        resetFilters={resetFilters}
      />

      {/* 结果统计 */}
      <div className="flex items-center justify-between text-sm text-text-tertiary">
        <span>
          共 <span className="font-medium text-text-primary">{filteredModels.length}</span> 个模型
          {filters.searchQuery && <span className="ml-2">（搜索：「{filters.searchQuery}」）</span>}
        </span>
        {filteredModels.length === 0 && <span className="text-warning">无匹配模型，请调整筛选条件</span>}
      </div>

      {/* 结果列表 */}
      <div className="space-y-3">
        {Object.entries(modelsByProvider).map(([providerId, models]) => (
          <ProviderCard
            key={providerId}
            stats={providerStats.find((s) => s.providerId === providerId)!}
            models={models}
            currentProviderId={currentProviderId}
            currentModelId={currentModelId}
            onSelectModel={selectModel}
          />
        ))}
        {Object.keys(modelsByProvider).length === 0 && filteredModels.length === 0 && providersLoaded && (
          <div className="rounded-md border border-border bg-bg-secondary p-6 text-center text-text-tertiary">
            暂无模型数据
          </div>
        )}
      </div>
    </div>
  );
}