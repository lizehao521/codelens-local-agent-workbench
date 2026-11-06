/** Provider registry (spec section 5). One adapter covers all OpenAI-compatible providers. */

import type { ProviderInfo, ProviderModel } from '../types/index.js';

const PROVIDERS: ProviderInfo[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
    defaultModel: 'deepseek-v4-pro',
    docsUrl: 'https://platform.deepseek.com/api-docs',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-4.6', name: 'GLM-4.6' },
      { id: 'glm-4.5-air', name: 'GLM-4.5-Air' },
    ],
    defaultModel: 'glm-4.6',
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [
      { id: 'kimi-k2', name: 'Kimi K2' },
      { id: 'moonshot-v1-8k', name: 'Moonshot v1 8K' },
    ],
    defaultModel: 'kimi-k2',
    docsUrl: 'https://platform.moonshot.cn/docs/api/chat',
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen-max', name: 'Qwen Max' },
      { id: 'qwen-plus', name: 'Qwen Plus' },
    ],
    defaultModel: 'qwen-plus',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
      { id: 'gpt-4o', name: 'GPT-4o' },
    ],
    defaultModel: 'gpt-4o-mini',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA 推理端点',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: [
      { id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'NVIDIA Nemotron-3-Ultra-550B（已授权）' },
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'NVIDIA Llama-3.1-Nemotron-70B-Instruct' },
      { id: 'nvidia/llama-3.1-nemotron-51b-instruct', name: 'NVIDIA Llama-3.1-Nemotron-51B-Instruct' },
      { id: 'deepseek-ai/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash（NVIDIA 托管）' },
      { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6（NVIDIA 托管）' },
      { id: 'mistralai/mistral-large', name: 'Mistral Large（NVIDIA 托管）' },
    ],
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b',
    docsUrl: 'https://build.nvidia.com/api-catalog',
  },
  {
    id: 'custom',
    name: '自定义 OpenAI 兼容端点',
    baseUrl: '',
    models: [],
    defaultModel: '',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
  },
];

const BY_ID = new Map<string, ProviderInfo>(PROVIDERS.map((p) => [p.id, p]));

/**
 * 同步覆盖层：ModelSyncService 写入的「上游同步模型」。按 provider id 覆盖静态默认，
 * provider 内 models 按 id 合并（同步模型优先，含 capabilities）。
 */
const SYNCED = new Map<string, ProviderInfo>();

function cloneProvider(p: ProviderInfo): ProviderInfo {
  return { ...p, models: p.models.map((m) => ({ ...m } as ProviderModel)) };
}

/** 由 ModelSyncService 调用：写入一次成功同步的 provider 列表（整体替换）。 */
export function setSyncedProviders(list: ProviderInfo[]): void {
  SYNCED.clear();
  for (const p of list) SYNCED.set(p.id, cloneProvider(p));
}

/** 合并视图：静态默认 + 同步覆盖层（同步字段优先，models 按 id 合并、同步优先）。 */
function mergedProvider(id: string): ProviderInfo | undefined {
  const base = BY_ID.get(id);
  const synced = SYNCED.get(id);
  if (!base && !synced) return undefined;
  if (!synced) return cloneProvider(base!);
  if (!base) return cloneProvider(synced);
  const mergedModels = new Map<string, ProviderModel>();
  for (const m of base.models) mergedModels.set(m.id, { ...m });
  for (const m of synced.models) mergedModels.set(m.id, { ...m }); // 同步模型优先（含 capabilities）
  return {
    id: base.id,
    name: synced.name || base.name,
    baseUrl: synced.baseUrl || base.baseUrl,
    defaultModel: synced.defaultModel || base.defaultModel,
    docsUrl: synced.docsUrl || base.docsUrl,
    models: [...mergedModels.values()],
  };
}

/** Public registry copy (never mutated by callers). 合并静态默认与同步覆盖层。 */
export function listProviders(): ProviderInfo[] {
  const ids = new Set<string>([...PROVIDERS.map((p) => p.id), ...SYNCED.keys()]);
  const out: ProviderInfo[] = [];
  for (const id of ids) {
    const merged = mergedProvider(id);
    if (merged) out.push(merged);
  }
  return out;
}

/** 单个 provider 的合并视图（静态优先结构、同步字段覆盖）。同步层注册的上游
 * （如 openai-compatible）不在静态表中，靠 SYNCED 兜底才能被解析。 */
export function getProvider(id: string): ProviderInfo | undefined {
  const provider = mergedProvider(id);
  if (!provider) return undefined;
  return { ...provider, models: provider.models.map((m) => ({ ...m } as ProviderModel)) };
}

export function isModelOfProvider(providerId: string, modelId: string): boolean {
  const provider = getProvider(providerId);
  if (!provider) return false;
  if (provider.id === 'custom') return true; // user-defined model
  return provider.models.some((m) => m.id === modelId);
}

/**
 * 用户常把完整 endpoint 当 Base URL 填（如 `.../v1/chat/completions`），
 * 而 adapter 会自行拼接 `/chat/completions`，重复拼接会产生
 * `.../v1/chat/completions/chat/completions` → 404/401 难排查。此处统一归一化。
 */
const ENDPOINT_SUFFIX_RE = /\/+(?:chat\/completions|completions|responses|messages|embeddings|models)\/?$/i;

/** 归一化 Base URL：去尾斜杠 + 循环剥离误填的 endpoint 后缀。 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return '';
  url = url.replace(/\/+$/, '');
  // 循环剥离，兼容重复叠加（如 .../chat/completions/chat/completions）。
  for (let i = 0; i < 3; i += 1) {
    const next = url.replace(ENDPOINT_SUFFIX_RE, '').replace(/\/+$/, '');
    if (next === url) break;
    url = next;
  }
  return url;
}

/** Resolve the effective base URL (custom providers supply their own). */
export function resolveBaseUrl(providerId: string, customBaseUrl?: string): string {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`unknown provider: ${providerId}`);
  if (provider.id === 'custom') {
    // 请求自带 URL 优先；其次回落合并层 baseUrl（上游目录以 custom id 注册时的兜底）。
    const url = normalizeBaseUrl(customBaseUrl?.trim() || provider.baseUrl?.trim() || '');
    if (!url) throw new Error('customBaseUrl is required for custom provider');
    return url;
  }
  return normalizeBaseUrl(provider.baseUrl ?? '');
}
