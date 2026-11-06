// 模型能力面板 —— 从 /providers 目录动态渲染模型选择、能力标签、调用限制、能力开关与状态
// 数据事实源：settingsStore.providers（服务端 /providers 合并目录）。降级目录能力显示「未知」，不伪造。
// 设计契约：docs/design/model-capability-design.md

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Cpu,
  Gauge,
  Info,
  Layers,
  Loader,
  RefreshCw,
  Sparkles,
  Zap,
} from 'lucide-react';
import type { ModelCapabilities, ProviderModel, Settings } from '../../types';
import { useSettingsStore } from '../../stores/settingsStore';
import { getProviderSyncStatus } from '../../services/api';
import { isSameUpstream, normalizeBaseUrl } from '../../lib/base-url';
import { Dropdown, Field } from './FormControls';
import { cn } from '../../lib/cn';

type ChannelMode = NonNullable<Settings['channelMode']>;

const CHANNELS: { value: ChannelMode; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'native', label: '原生工具' },
  { value: 'react', label: '提示词解析' },
];

function fmtCount(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : new Intl.NumberFormat('zh-CN').format(n);
}

/** 能力标签词表（固定中文，图标用 lucide，不使用 emoji —— P0）。 */
function buildBadges(caps: ModelCapabilities): { key: string; label: string; tone: 'ok' | 'warn' | 'muted' }[] {
  const badges: { key: string; label: string; tone: 'ok' | 'warn' | 'muted' }[] = [];
  badges.push(
    caps.nativeTools
      ? { key: 'tools', label: '原生工具', tone: 'ok' }
      : { key: 'tools', label: '提示词解析', tone: 'warn' },
  );
  if (caps.contextWindow) badges.push({ key: 'ctx', label: `上下文 ${fmtCount(caps.contextWindow)}`, tone: 'muted' });
  if (caps.retainReasoningContent) badges.push({ key: 'reason', label: '保留推理', tone: 'muted' });
  if (caps.explicitParallelToolCalls) badges.push({ key: 'par', label: '并行工具', tone: 'muted' });
  if (caps.requireToolStreamFlag) badges.push({ key: 'ts', label: '需 tool_stream', tone: 'warn' });
  if (caps.toolChoiceValues?.length) badges.push({ key: 'tc', label: `tool_choice ${caps.toolChoiceValues.length} 档`, tone: 'muted' });
  return badges;
}

function LimitItem({ label, value, unit }: { label: string; value: number | null; unit?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-text-tertiary">{label}</span>
      {value === null || value === undefined ? (
        <span className="text-xs text-text-tertiary">未标注</span>
      ) : (
        <span className="text-sm font-medium text-text-primary">
          {fmtCount(value)}
          {unit ? <span className="ml-0.5 text-text-tertiary">{unit}</span> : null}
        </span>
      )}
    </div>
  );
}

export function ModelCapabilityPanel({ locked = false }: { locked?: boolean } = {}) {
  const settings = useSettingsStore((s) => s.settings);
  const providers = useSettingsStore((s) => s.providers);
  const providersLoading = useSettingsStore((s) => s.providersLoading);
  const providersError = useSettingsStore((s) => s.providersError);
  const providersLoaded = useSettingsStore((s) => s.providersLoaded);
  const update = useSettingsStore((s) => s.update);
  const refreshProviders = useSettingsStore((s) => s.refreshProviders);
  const selectProvider = useSettingsStore((s) => s.selectProvider);

  const [expandBadges, setExpandBadges] = useState(false);
  const [sync, setSync] = useState<{ lastStatus: string; lastModelCount: number | null; lastRunAt: number | null } | null>(null);

  const currentProvider = providers.find((p) => p.id === settings.provider) ?? providers[0];
  const models = currentProvider?.models ?? [];
  const selected: ProviderModel | undefined = useMemo(
    () => models.find((m) => m.id === settings.model),
    [models, settings.model],
  );
  const caps = selected?.capabilities ?? null;
  const limits = selected?.limits ?? null;

  // custom 手填态的下沉引导：若用户填的 Base URL 与某个已同步 provider 同源，
  // 说明该上游其实已经同步好了模型目录 —— 直接切过去就能下拉选择，不必手填模型 ID。
  const syncedMatch = useMemo(() => {
    if (settings.provider !== 'custom') return null;
    const target = normalizeBaseUrl(settings.customBaseUrl);
    if (!target) return null;
    return (
      providers.find(
        (p) => p.id !== 'custom' && p.models.length > 0 && isSameUpstream(p.baseUrl, target),
      ) ?? null
    );
  }, [providers, settings.customBaseUrl, settings.provider]);

  // 同步状态（旁路徽标，失败不影响目录）
  useEffect(() => {
    let cancelled = false;
    void getProviderSyncStatus()
      .then((data) => !cancelled && setSync(data.sync))
      .catch(() => !cancelled && setSync(null));
    return () => {
      cancelled = true;
    };
  }, [providersLoaded]);

  const badges = caps ? buildBadges(caps) : [];
  const visible = expandBadges ? badges : badges.slice(0, 5);
  const hiddenCount = badges.length - visible.length;
  const nativeUnsupported = caps ? caps.nativeTools === false : false;

  return (
    <div className="space-y-3">
      {/* 同步状态条（旁路徽标） */}
      {sync && (
        <div
          className={cn(
            'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs',
            sync.lastStatus === 'success' && 'border-success bg-success-subtle text-success',
            sync.lastStatus === 'failed' && 'border-danger bg-danger-subtle text-danger',
            sync.lastStatus !== 'success' && sync.lastStatus !== 'failed' && 'border-border text-text-tertiary',
          )}
        >
          {sync.lastStatus === 'success' ? (
            <span>
              上游同步成功 · {sync.lastModelCount ?? 0} 个模型
              {sync.lastRunAt ? ` · ${new Date(sync.lastRunAt).toLocaleTimeString('zh-CN')}` : ''}
            </span>
          ) : sync.lastStatus === 'failed' ? (
            <span className="flex items-center gap-1.5">
              <AlertTriangle size={13} /> 上游模型同步失败
            </span>
          ) : (
            <span>尚未同步上游模型</span>
          )}
          <button
            type="button"
            onClick={() => void refreshProviders(true)}
            className="ml-auto flex items-center gap-1 text-text-secondary transition-colors duration-150 hover:text-accent"
          >
            <RefreshCw size={12} /> 刷新
          </button>
        </div>
      )}

      {/* 异常条 + 重试（降级不空白） */}
      {providersError && (
        <div className="flex items-center gap-2 rounded-md border border-danger bg-danger-subtle px-2.5 py-1.5 text-xs text-danger">
          <AlertTriangle size={13} />
          <span className="flex-1">模型目录加载失败：{providersError}（已降级到本地默认目录）</span>
          <button
            type="button"
            onClick={() => void refreshProviders(true)}
            className="shrink-0 rounded border border-danger px-2 py-0.5 transition-colors duration-150 hover:bg-danger-subtle"
          >
            重试
          </button>
        </div>
      )}

      {/* 已同步同源提示：custom 手填态下，避免用户不知道「其实有列表可选」 */}
      {syncedMatch && (
        <div className="flex items-center gap-2 rounded-md border border-accent bg-accent-subtle px-2.5 py-1.5 text-xs text-accent">
          <Info size={13} className="shrink-0" />
          <span className="flex-1">
            这个地址已同步为「{syncedMatch.name}」，有 {syncedMatch.models.length} 个模型可直接下拉选择。
          </span>
          <button
            type="button"
            onClick={() => selectProvider(syncedMatch.id)}
            className="shrink-0 rounded border border-accent px-2 py-0.5 transition-colors duration-150 hover:bg-accent hover:text-bg-primary"
          >
            切换
          </button>
        </div>
      )}

      {/* 模型选择（加载骨架 / 有列表下拉 / custom 输入） */}
      <Field label="模型">
        {providersLoading && !providersLoaded ? (
          <div className="h-9 w-full animate-pulse rounded-md bg-bg-secondary" />
        ) : models.length > 0 ? (
          <Dropdown
            value={settings.model}
            onChange={(model) => update({ model })}
            options={models.map((m) => ({ value: m.id, label: m.name }))}
            disabled={locked}
          />
        ) : (
          <input
            value={settings.model}
            onChange={(e) => update({ model: e.target.value })}
            disabled={locked}
            placeholder={
              syncedMatch
                ? `手填模型 ID（或点上方「切换」改用 ${syncedMatch.models.length} 个已同步模型）`
                : '填写 OpenAI 兼容模型 ID（如 deepseek-v4-pro）'
            }
            className="w-full rounded-md border border-border bg-bg-primary px-2.5 py-1.5 text-base text-text-primary focus:border-accent"
          />
        )}
      </Field>

      {/* 能力标签 + 探测状态 */}
      {providersLoading && !providersLoaded ? (
        <div className="flex flex-wrap gap-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-5 w-16 animate-pulse rounded bg-bg-secondary" />
          ))}
        </div>
      ) : caps ? (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
            <Cpu size={12} /> 能力标签
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {visible.map((b) => (
              <span
                key={b.key}
                className={cn(
                  'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                  b.tone === 'ok' && 'border-success bg-success-subtle text-success',
                  b.tone === 'warn' && 'border-warning bg-warning-subtle text-warning',
                  b.tone === 'muted' && 'border-border text-text-secondary',
                )}
              >
                {b.key === 'tools' && (caps.nativeTools ? <Zap size={11} /> : <Layers size={11} />)}
                {b.key === 'reason' && <Sparkles size={11} />}
                {b.label}
              </span>
            ))}
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setExpandBadges(true)}
                className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-secondary hover:border-accent hover:text-accent"
              >
                +{hiddenCount}
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="text-xs text-text-tertiary">能力未知（本地降级目录无能力数据）—— 首次运行该模型时自动探测。</p>
      )}

      {/* 调用限制 */}
      {limits && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
            <Gauge size={12} /> 调用限制
          </div>
          <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-bg-secondary p-2.5 sm:grid-cols-4">
            <LimitItem label="输出上限" value={limits.maxOutputTokens} unit="tok" />
            <LimitItem label="请求频率" value={limits.rateLimitRpm} unit="req/min" />
            <LimitItem label="Token 频率" value={limits.rateLimitTpm} unit="tok/min" />
            <LimitItem label="并发" value={limits.maxConcurrent} />
          </div>
          {limits.rateLimitRpm === null && limits.rateLimitTpm === null && (
            <p className="text-[11px] text-text-tertiary">上游未声明限速，建议保守并发。</p>
          )}
        </div>
      )}

      {/* 能力开关（通道模式，native 依能力禁用） */}
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
          <Cpu size={12} /> 通道模式（能力开关）
        </div>
        <div className="flex gap-1.5">
          {CHANNELS.map((c) => {
            const disabled = c.value === 'native' && nativeUnsupported;
            const active = (settings.channelMode ?? 'auto') === c.value;
            return (
              <button
                key={c.value}
                type="button"
                disabled={disabled}
                onClick={() => update({ channelMode: c.value })}
                title={disabled ? '该模型不支持原生工具调用' : undefined}
                className={cn(
                  'flex-1 rounded-md border px-2 py-1.5 text-xs transition-colors duration-150',
                  active ? 'border-accent bg-accent-subtle text-accent' : 'border-border text-text-primary hover:border-accent',
                  disabled && 'cursor-not-allowed opacity-40 hover:border-border',
                )}
              >
                {c.label}
              </button>
            );
          })}
        </div>
        {nativeUnsupported && (
          <p className="text-[11px] text-warning">该模型不支持原生工具，已禁用「原生工具」选项，将走提示词解析。</p>
        )}
      </div>

      {/* 加载中提示 */}
      {providersLoading && (
        <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
          <Loader size={12} className="animate-spin" /> 正在加载模型目录…
        </div>
      )}
    </div>
  );
}
