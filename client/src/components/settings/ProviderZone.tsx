// 设置分区 ① —— Provider + Key + 能力面板 + 探测（AC-01）
// 模型选择 / 能力标签 / 调用限制 / 能力开关 由 ModelCapabilityPanel 自动获取并渲染。
// 探测策略：服务端无独立探测端点（契约冻结 22 个），改用最小 agent 流触发通道路由探测，
// 读 meta.channel 回填；supported → native，否则 react 并在运行卡标注「提示词解析模式」。

import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleCheck, CircleX, Eye, EyeOff, Loader } from 'lucide-react';
import type { Provider, Settings } from '../../types';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { getTrialStatus, type TrialStatus } from '../../services/api';
import { openAgentStream, parseAgentSSE } from '../../services/stream';
import { Dropdown, Field } from './FormControls';
import { ModelCapabilityPanel } from './ModelCapabilityPanel';
import { cn } from '../../lib/cn';

type ProbeState = 'idle' | 'probing' | 'native' | 'react' | 'error';

export function ProviderZone() {
  const settings = useSettingsStore((s) => s.settings);
  const providers = useSettingsStore((s) => s.providers);
  const update = useSettingsStore((s) => s.update);
  const pushToast = useUiStore((s) => s.pushToast);
  const [showKey, setShowKey] = useState(false);
  const [probe, setProbe] = useState<ProbeState>('idle');
  const [probeNote, setProbeNote] = useState<string | null>(null);
  const probeController = useRef<AbortController | null>(null);
  const [trial, setTrial] = useState<TrialStatus | null>(null);

  const isCustom = settings.provider === 'custom';
  // 试用锁定：服务端在「无 BYOK Key」时会强制改上游与模型；前端必须把这件事显式化，
  // 否则用户以为切了上游其实没生效（上一轮 401 的根因）。
  const trialLocked = Boolean(trial?.enabled) && !settings.apiKey.trim();
  const lockedModel = trial?.trialUpstream?.model ?? settings.model;

  useEffect(() => () => probeController.current?.abort(), []);

  // 拉取试用状态（失败不阻断设置面板，只是不锁定 UI）。
  useEffect(() => {
    let alive = true;
    getTrialStatus()
      .then((s) => alive && setTrial(s))
      .catch(() => alive && setTrial(null));
    return () => {
      alive = false;
    };
  }, []);

  const handleProviderChange = (providerId: string): void => {
    const provider: Provider | undefined = providers.find((p) => p.id === providerId);
    const patch: Partial<Settings> = { provider: providerId };
    if (provider?.defaultModel) patch.model = provider.defaultModel;
    update(patch);
    setProbe('idle');
    setProbeNote(null);
  };

  /** 最小 agent 流触发探测：只等 meta 事件即中止（不消耗完整任务） */
  const handleProbe = useCallback(async (): Promise<void> => {
    const key = settings.apiKey.trim();
    if (!key) {
      pushToast({ message: '请先填写 API Key', variant: 'error' });
      return;
    }
    if (isCustom && !settings.customBaseUrl?.trim()) {
      pushToast({ message: '自定义 Provider 需要 Base URL', variant: 'error' });
      return;
    }
    if (!settings.model.trim()) {
      pushToast({ message: '请先选择模型（或填写自定义模型名称）', variant: 'error' });
      return;
    }
    setProbe('probing');
    setProbeNote(null);
    const controller = new AbortController();
    probeController.current = controller;
    try {
      const res = await openAgentStream(
        {
          provider: settings.provider,
          model: settings.model,
          apiKey: key,
          message: 'ping',
          maxIterations: 5,
          maxTokens: 64,
          ...(settings.customBaseUrl?.trim() ? { customBaseUrl: settings.customBaseUrl.trim() } : {}),
        },
        controller.signal,
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setProbe('error');
        setProbeNote(data?.error?.message ?? `探测失败（HTTP ${res.status}）`);
        return;
      }
      let settled = false;
      await parseAgentSSE(res, {
        onMeta: (meta) => {
          settled = true;
          setProbe(meta.channel === 'native' ? 'native' : 'react');
          setProbeNote(
            meta.channel === 'native'
              ? '该模型支持原生 function calling'
              : '该模型不支持原生调用，将自动使用提示词解析模式',
          );
          controller.abort();
        },
        onError: (err) => {
          settled = true;
          setProbe('error');
          setProbeNote(err.message);
          controller.abort();
        },
      });
      if (!settled) {
        setProbe('error');
        setProbeNote('探测流异常结束');
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setProbe('error');
        setProbeNote(err instanceof Error ? err.message : '网络错误');
      }
    } finally {
      probeController.current = null;
    }
  }, [isCustom, pushToast, settings.apiKey, settings.customBaseUrl, settings.model, settings.provider]);

  const trialHealth = trial?.trialUpstream?.health ?? null;

  return (
    <div className="space-y-4">
      {trialLocked && (
        <div className="rounded-md border border-border-subtle bg-bg-inset px-2.5 py-2 text-xs text-text-secondary">
          <p>
            当前为<strong className="text-text-primary">免费试用</strong>：上游由服务端统一提供（固定模型{' '}
            <span className="font-mono text-text-primary">{lockedModel}</span>）。
          </p>
          <p className="mt-1">切换上游或模型请在下方「API Key」里自带 Key；有 Key 后即可自由切换。</p>
          {trialHealth && trialHealth.status !== 'ok' && trialHealth.status !== 'unknown' && (
            <p className="mt-1 text-danger">
              {trialHealth.status === 'auth_failed'
                ? '试用上游认证失败（服务端 Key 无效或无此模型权限）'
                : '试用上游不可达或暂不可用'}
              ：{trialHealth.detail ?? '探测未通过'}。可稍后重试，或配置自己的 API Key。
            </p>
          )}
        </div>
      )}

      <Field label="Provider">
        <Dropdown
          value={settings.provider}
          onChange={handleProviderChange}
          options={providers.map((p) => ({ value: p.id, label: p.name }))}
          disabled={trialLocked}
          hint={trialLocked ? '试用期间上游已锁定；切换上游请自带 API Key' : undefined}
        />
      </Field>

      {isCustom ? (
        <Field label="Base URL" hint="OpenAI 兼容端点，必须以 https:// 开头">
          <input
            value={settings.customBaseUrl ?? ''}
            onChange={(e) => update({ customBaseUrl: e.target.value })}
            placeholder="https://your-endpoint/v1"
            className="w-full rounded-md border border-border bg-bg-primary px-2.5 py-1.5 text-base text-text-primary focus:border-accent"
          />
        </Field>
      ) : null}

      {/* 模型能力面板：模型选择 + 能力标签 + 调用限制 + 能力开关 + 状态 */}
      <ModelCapabilityPanel locked={trialLocked} />

      <Field label="API Key" hint="仅保存在本浏览器 localStorage，随请求发送给对应 Provider">
        <div className="flex items-center gap-1.5">
          <input
            type={showKey ? 'text' : 'password'}
            value={settings.apiKey}
            onChange={(e) => update({ apiKey: e.target.value })}
            placeholder="sk-…"
            autoComplete="off"
            className="w-full rounded-md border border-border bg-bg-primary px-2.5 py-1.5 text-base text-text-primary focus:border-accent"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="shrink-0 rounded-md border border-border p-1.5 text-text-secondary transition-colors duration-150 hover:border-accent hover:text-accent"
            aria-label={showKey ? '隐藏密钥' : '显示密钥'}
          >
            {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
      </Field>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleProbe()}
          disabled={probe === 'probing'}
          className={cn(
            'flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-primary',
            'transition-colors duration-150 hover:border-accent disabled:opacity-50',
          )}
        >
          {probe === 'probing' ? <Loader size={14} className="animate-spin" /> : null}
          测试连通性与能力
        </button>
        {probe === 'native' && (
          <span className="flex items-center gap-1 text-xs text-success">
            <CircleCheck size={13} /> 原生 function calling
          </span>
        )}
        {probe === 'react' && (
          <span className="flex items-center gap-1 text-xs text-warning">
            <CircleCheck size={13} /> 提示词解析模式
          </span>
        )}
        {probe === 'error' && (
          <span className="flex items-center gap-1 text-xs text-danger">
            <CircleX size={13} /> {probeNote ?? '探测失败'}
          </span>
        )}
        {probeNote && probe !== 'error' && <span className="text-xs text-text-tertiary">{probeNote}</span>}
      </div>
      <p className="text-xs text-text-tertiary">
        探测会写入 provider_capabilities（按模型粒度，不每轮试探）。结果同时决定 Agent 使用原生调用还是
        提示词解析模式，切换时运行卡会标注。
      </p>
    </div>
  );
}
