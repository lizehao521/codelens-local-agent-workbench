// 模型中转服务的本地配置读取 —— 运行时接口（dev/preview 中间件提供），密钥不进入 bundle。
// 静态部署下接口 404：返回 null，由 UI 回退到内置模型快照 + 手动填写，并明确说明。

export interface RelayLocalConfig {
  baseUrl: string;
  model: string;
  /** 是否在 .env.local 里配置了 RELAY_API_KEY */
  hasApiKey: boolean;
  /** 仅在本地 dev/preview 下由中间件返回；静态部署为空串 */
  apiKey: string;
}

/** 已实测可用的中转模型快照（2026-11-10 拉取 /v1/models，共 44 个）；
 *  静态部署拿不到实时列表时作为手动输入候选，不冒充实时数据。 */
export const RELAY_KNOWN_MODELS = [
  '平衡',
  '推理',
  '旗舰',
  '旗舰-any',
  '极速',
  '极速-any',
  'default',
  'deepseek-v4.1-flash',
  'deepseek-v4-pro-0813',
  'deepseek-v4-flash',
  'deepseek-chat',
  'deepseek-reasoner',
  'claude-3-5-sonnet',
  'claude-3-5-sonnet-20241022',
  'claude-3-haiku',
  'claude-3-opus',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemma-4-31b-it',
  'gemsi-flash',
  'glm-5.3-flash',
  'gpt-3.5-turbo',
  'gpt-35-turbo',
  'gpt-4',
  'gpt-4-turbo',
  'gpt-4o',
  'gpt-4o-mini',
  'o1',
  'o1-mini',
  'o3-mini',
  'laguna-xs-2.1',
  'mimo-v2.6-flash',
  'minicpm-v-4.7-35b-a3b',
  'minicpm5-2b',
  'minimax-m3',
  'mistral-large-4-1t-a52b',
  'muse-glimmer-30b',
  'nemotron-3-nano-omni-30b-a3b-reasoning',
  'nemotron-3-ultra-550b-a55b',
  'nemotron-3.5-bolt-e4b',
  'nemotron-3.5-lightning-30b-a3b',
  'nemotron-3.5-super-vl-120b-a12b',
  'qwen3.8-27b',
  'qwen3.8-flash-next',
];

const TIMEOUT_MS = 10_000;

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

async function fetchJson(url: string): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    const text = await res.text();
    if (!text) return { status: res.status, data: null };
    // 静态部署常见 SPA fallback：未知路径返回 index.html（200）。按「本地接口不存在」处理。
    if (text.trimStart().startsWith('<')) return { status: 404, data: null };
    try {
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      throw new HttpError(`本地服务返回格式异常（HTTP ${res.status}）`, res.status);
    }
  } catch (err) {
    if (controller.signal.aborted) throw new HttpError('读取本地中转配置超时（10s）', 0);
    if (err instanceof HttpError) throw err;
    throw new HttpError(`无法访问本地中转配置：${err instanceof Error ? err.message : '网络错误'}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(data: unknown): string {
  const message = (data as { error?: unknown } | null)?.error;
  if (typeof message === 'string' && message) return message;
  return '';
}

/** 读取本地中转配置；静态部署（404）返回 null，其余失败抛出可展示的错误。 */
export async function fetchRelayLocalConfig(): Promise<RelayLocalConfig | null> {
  const { status, data } = await fetchJson('/local-relay-config.json');
  if (status === 404) return null;
  if (status >= 400) throw new HttpError(errorMessage(data) || `读取本地中转配置失败（HTTP ${status}）`, status);
  const raw = data as Partial<RelayLocalConfig> | null;
  if (!raw || typeof raw.baseUrl !== 'string') {
    throw new HttpError('本地中转配置格式异常：缺少 baseUrl', status);
  }
  return {
    baseUrl: raw.baseUrl,
    model: typeof raw.model === 'string' && raw.model ? raw.model : '平衡',
    hasApiKey: Boolean(raw.hasApiKey),
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
  };
}

export interface RelayModelsResult {
  models: string[];
  /** 来源：local=本地中间件实时拉取；snapshot=静态部署下的内置快照 */
  source: 'local' | 'snapshot';
  note?: string;
}

/** 拉取中转模型列表。404 表示静态部署没有本地中间件，回退内置快照并给出说明。 */
export async function fetchRelayModels(): Promise<RelayModelsResult> {
  const startedAt = Date.now();
  const { status, data } = await fetchJson('/local-relay-models.json');
  if (status === 404) {
    return {
      models: RELAY_KNOWN_MODELS,
      source: 'snapshot',
      note: '静态部署下无法直连中转（无本地中间件），候选来自内置快照；模型名仍可手动填写。',
    };
  }
  if (status >= 400) {
    throw new HttpError(errorMessage(data) || `拉取中转模型失败（HTTP ${status}）`, status);
  }
  const models = (data as { models?: unknown } | null)?.models;
  if (!Array.isArray(models) || models.some((m) => typeof m !== 'string')) {
    throw new HttpError('中转服务返回格式异常：模型列表不是字符串数组', status);
  }
  const elapsed = Date.now() - startedAt;
  return {
    models: models as string[],
    source: 'local',
    note: `已连接中转服务 · ${models.length} 个模型 · ${elapsed}ms`,
  };
}
