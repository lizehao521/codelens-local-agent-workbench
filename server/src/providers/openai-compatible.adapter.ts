/**
 * OpenAI-compatible adapter: one implementation covers every provider in the registry.
 * v2.0: streaming tool_call deltas are accumulated by tool-call-normalizer (the old
 * code concatenated argument fragments into visible text and dropped id/name/index,
 * which breaks agent flows). tools/tool_choice are emitted conditionally per the
 * provider capability table. probeToolSupport() implements AC-01 detection.
 */

import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { AppError, ErrorCode } from '../utils/errors.js';
import type {
  NormalizedToolCall,
  ProviderToolSpec,
  UpstreamEvent,
  UpstreamMessage,
  Usage,
} from '../types/index.js';
import type { ProviderCapabilities } from '../types/index.js';
import {
  accumulate,
  createToolCallAccumulator,
  finalize,
  type ToolCallAccumulator,
} from './tool-call-normalizer.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ChatParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: UpstreamMessage[];
  temperature: number;
  maxTokens: number;
  stream: boolean;
  /** Provider wire-format tool specs (wire names only). */
  tools?: ProviderToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required' | string;
  parallelToolCalls?: boolean;
  toolStream?: boolean;
  /**
   * R3：上游返回响应头（已"响应"）时回调一次。用于发 upstream_first_byte 阶段，
   * 与「首个内容块」区分：有些模型会先回 200 再长时间不吐 token。
   */
  onResponseStart?: () => void;
}

export interface ChatResult {
  content: string;
  finishReason: string;
  usage: Usage;
  toolCalls: NormalizedToolCall[];
}

export interface AdapterOptions {
  fetchFn?: FetchLike;
  timeoutMs?: number;
  /**
   * 连接类失败的重试次数（默认 0）。只重试「未拿到响应头」的网络错误；
   * 超时与 HTTP 4xx 不重试——超时重试会把用户等待翻倍，401 重试只是重复失败。
   */
  retries?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
// 长流式超时放宽：550B 等慢模型在思考期常长时间不吐 chunk，Node 内置 fetch（undici）默认
// bodyTimeout=300s 会误断长连接。单连接 body 超时放宽到 30 分钟；首字节仍由 headersTimeout(300s) 兜底。
//
// 代理：Node 的 fetch 不读 HTTP_PROXY/HTTPS_PROXY 环境变量（Python/curl 会读），
// 在需要经 egress 代理出网的沙箱/企业网络下会表现为「直接连不上上游」。
// 存在代理变量时改用 EnvHttpProxyAgent（自动遵循 NO_PROXY），否则保持直连 Agent。
const DISPATCHER_OPTIONS = { bodyTimeout: 30 * 60 * 1000, headersTimeout: 300_000 };
const PROXY_ENV = [
  process.env.HTTPS_PROXY,
  process.env.https_proxy,
  process.env.HTTP_PROXY,
  process.env.http_proxy,
].find((v) => typeof v === 'string' && v.trim() !== '');
const LONG_STREAM_DISPATCHER: Dispatcher = PROXY_ENV
  ? (new EnvHttpProxyAgent(DISPATCHER_OPTIONS) as Dispatcher)
  : new Agent(DISPATCHER_OPTIONS);
const ERROR_BODY_MAX_CHARS = 500;

export type ProbeOutcome =
  | { status: 'supported'; evidence: 'tool_calls_returned' }
  | { status: 'unsupported'; evidence: 'text_response' | 'tools_param_rejected' }
  /**
   * `probe_truncated`：探测请求被 max_tokens 截断（推理型模型的思维链会吃掉预算），
   * 既没拿到 tool_calls 也没拿到明确拒绝。这属于「没测出来」，必须与
   * 「测出来不支持」区分开——否则能力表里会留下一个错误的否定结论。
   */
  | { status: 'failed'; evidence: 'network' | 'auth' | 'probe_truncated'; detail: string }
  /**
   * `cancelled`：调用方中止（用户停止 / 服务关闭）。这不是能力结论，也不代表
   * 网络故障——上层既不能落库，也不能把它当 error 报给用户。
   */
  | { status: 'cancelled'; evidence: 'aborted' };

function maskKey(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('***');
}

/** 从上游错误报文中提取 relay 网关给出的 key 指纹（形如「指纹 0207eaa1」）。 */
function extractKeyFingerprint(text: string): string | null {
  const m = /(?:指纹|fingerprint)\s*[:：]?\s*([0-9a-fA-F]{4,64})/.exec(text);
  return m?.[1] ?? null;
}

/** 只取主机名用于错误诊断：不泄露路径/查询串，也绝不带 key。 */
function upstreamHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * 把上游 JSON 错误翻译成人能直接照做的话术。
 * 认证类（401/403）最常见也最容易被一坨 JSON 糊住，单独产出可执行引导。
 */
export function describeHttpError(status: number, raw: string, apiKey: string, baseUrl?: string): string {
  const safe = maskKey(raw, apiKey);
  const host = baseUrl ? upstreamHost(baseUrl) : '';
  const label = host ? `上游（${host}）` : '上游';
  let parsed: { message?: string; code?: string; type?: string } = {};
  try {
    const json = JSON.parse(safe) as {
      error?: { message?: string; code?: string; type?: string };
      message?: string;
      code?: string;
      type?: string;
    };
    const err = json.error ?? json;
    parsed = { message: err.message, code: err.code, type: err.type };
  } catch {
    // 非 JSON（HTML/纯文本）：走通用分支
  }

  if (status === 401 || status === 403) {
    const fingerprint = extractKeyFingerprint(parsed.message ?? safe);
    const isRelayKey = parsed.code === 'invalid_key' || /relay\s*key/i.test(parsed.message ?? '');
    const lines: string[] = [];
    if (isRelayKey) {
      lines.push(`${label}认证失败（HTTP ${status}）：relay key 未被网关认可${fingerprint ? `（指纹 ${fingerprint}）` : ''}。`);
      lines.push('常见原因（按概率）：① 还在用旧 key——轮换或删除后立即作废；② 这份配置读的存储里没有这个 key——面板创建的 key 只落在它当时那份配置的数据库里，换一份配置（或换 storage.path）启动，同一台机器也认不出；③ 把上游厂商的 key 当成了 relay key。');
      lines.push('下一步：到网关 /admin →「客户 Key」页核对已签发 key 的指纹（或粘贴你手上的 key 自检），确认后回到本机 设置 → Provider 更新 API Key。');
      return lines.join('\n');
    }
    lines.push(`${label}认证失败（HTTP ${status}）：API Key 无效、已过期或无该模型权限。`);
    lines.push('下一步：到 设置 → Provider 重新填写 API Key（注意别把厂商 key 与 relay key 混用）。');
    if (parsed.message) lines.push(`上游原文：${parsed.message.slice(0, 200)}`);
    return lines.join('\n');
  }

  if (status === 404 || /model.{0,24}(not.?found|does.?not.?exist|unknown)|模型不存在|没有该模型/i.test(parsed.message ?? '')) {
    return [
      `${label}不认识这个模型（HTTP ${status}）。`,
      '可能原因：模型名拼错 / 该 key 无此模型权限 / Base URL 路径不对（应指向以 /v1 结尾的地址）。',
      '下一步：到 设置 → Provider 核对模型名与 Base URL；免费试用期间模型由服务端固定，需换模型请自带 API Key。',
      parsed.message ? `上游原文：${parsed.message.slice(0, 200)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (status === 429) {
    return [
      `${label}限速（HTTP 429）：请求超过该 key 的速率/并发上限。`,
      '下一步：稍后重试，或到 设置 → Provider 查看该模型的「调用限制」，降低并发/更换模型。',
      parsed.message ? `上游原文：${parsed.message.slice(0, 200)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const detail = safe.length > 0 ? `: ${safe}` : '';
  return `上游服务返回错误 (HTTP ${status})${detail}${host ? `；上游节点 ${host}` : ''}`;
}

async function readErrorBody(response: Response, apiKey: string, baseUrl?: string): Promise<string> {
  let raw = '';
  try {
    raw = (await response.text()).slice(0, ERROR_BODY_MAX_CHARS);
  } catch {
    raw = '';
  }
  return describeHttpError(response.status, raw, apiKey, baseUrl);
}

function extractContent(message: unknown): string {
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    return message
      .map((part) => {
        if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        if (part && typeof part === 'object' && 'content' in part) {
          return extractContent((part as { content?: unknown }).content);
        }
        return '';
      })
      .join('');
  }
  if (message && typeof message === 'object') {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return extractContent(content);
  }
  return '';
}

/** Raw delta.tool_calls entries. Items without `index` are kept (folded into slot 0). */
function extractToolCallDeltas(message: unknown): Array<{ index?: number; id?: string; function?: { name?: string; arguments?: unknown } }> {
  if (!message || typeof message !== 'object') return [];
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(toolCalls)) return [];
  const result: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: unknown } }> = [];
  for (const item of toolCalls) {
    if (!item || typeof item !== 'object') continue;
    const call = item as { index?: number; id?: string; function?: { name?: string; arguments?: unknown } };
    if (call.function === undefined && call.id === undefined) continue;
    result.push(call);
  }
  return result;
}

/**
 * Parses an upstream SSE byte stream into normalized events.
 * Tool-call fragments are accumulated and emitted ONCE as a `tool_calls` event
 * before `done` — including on abnormal stream endings (no [DONE]).
 */
export async function* parseUpstreamSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<UpstreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason = '';
  let usage: Usage = { promptTokens: 0, completionTokens: 0 };
  const acc: ToolCallAccumulator = createToolCallAccumulator();

  const readUsage = (source: unknown): void => {
    if (!source || typeof source !== 'object') return;
    const u = source as Record<string, unknown>;
    usage = {
      promptTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : usage.promptTokens,
      completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : usage.completionTokens,
    };
  };

  const handleData = (data: string): UpstreamEvent[] => {
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return [];
    }
    if (!payload || typeof payload !== 'object') return [];
    const root = payload as Record<string, unknown>;
    readUsage(root.usage);

    const choices = root.choices;
    if (!Array.isArray(choices) || choices.length === 0) return [];
    const choice = choices[0] as Record<string, unknown>;
    readUsage(choice.usage);
    if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
      finishReason = choice.finish_reason;
    }
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) return [];

    const events: UpstreamEvent[] = [];
    // Reasoning chains (DeepSeek/Kimi thinking mode) are a separate event.
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      events.push({ type: 'reasoning', text: delta.reasoning_content });
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      events.push({ type: 'delta', text: delta.content });
    } else if (Array.isArray(delta.content)) {
      const text = extractContent(delta.content);
      if (text.length > 0) events.push({ type: 'delta', text });
    }
    // Tool-call fragments produce NO frontend events: accumulate silently.
    const toolCalls = extractToolCallDeltas(delta);
    if (toolCalls.length > 0) {
      accumulate(acc, toolCalls as Parameters<typeof accumulate>[1]);
    }
    return events;
  };

  const emitToolCalls = function* (): Generator<UpstreamEvent> {
    const calls = finalize(acc);
    if (calls.length > 0) yield { type: 'tool_calls', calls };
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          yield* emitToolCalls();
          yield { type: 'done', finishReason: finishReason || 'stop', usage };
          return;
        }
        for (const event of handleData(data)) yield event;
      }
    }
  } catch (err) {
    // P0-1: a stream that breaks mid-flight has already been billed upstream
    // for the prompt (and any completion tokens that arrived before the
    // break). Attach the accumulated usage to the escaping error so the agent
    // loop can account for it instead of silently dropping those tokens.
    if (usage.promptTokens > 0 || usage.completionTokens > 0) {
      (err as { partialUsage?: Usage }).partialUsage = usage;
    }
    throw err;
  } finally {
    reader.releaseLock();
  }
  // Abnormal ending (no [DONE]): still finalize so calls are never lost.
  yield* emitToolCalls();
  yield { type: 'done', finishReason: finishReason || 'stop', usage };
}

/**
 * NVIDIA 兼容：其 /v1/chat/completions 拒绝 `role:"system"`，会返回
 * 400 "Conversation roles must alternate"。把 system 提示词折叠进首条 user
 * 消息（前置拼接）；若全程无 user 消息，则把累积的 system 作为一条 user 发出。
 * 仅当 caps.supportsSystemRole === false 时调用，其他 provider 不受影响。
 */
function foldSystemRole(messages: UpstreamMessage[]): UpstreamMessage[] {
  const out: UpstreamMessage[] = [];
  let sysAcc: string[] = [];
  for (const m of messages) {
    if (m.role !== 'system') {
      if (m.role === 'user' && sysAcc.length > 0 && typeof m.content === 'string') {
        const sys = sysAcc.join('\n\n');
        sysAcc = [];
        out.push({ ...m, content: `${sys}\n\n${m.content}` });
        continue;
      }
      out.push(m);
      continue;
    }
    if (typeof m.content === 'string') sysAcc.push(m.content);
  }
  if (sysAcc.length > 0) {
    out.push({ role: 'user', content: sysAcc.join('\n\n') });
  }
  return out;
}

/** Conditional body assembly per the capability table (architecture 7.3). */
export function buildChatBody(params: ChatParams, caps?: ProviderCapabilities): Record<string, unknown> {
  const messages =
    caps?.supportsSystemRole === false ? foldSystemRole(params.messages) : params.messages;
  const body: Record<string, unknown> = {
    model: params.model,
    messages,
    temperature: params.temperature,
    max_tokens: params.maxTokens,
    stream: params.stream,
  };
  if (params.stream) {
    body.stream_options = { include_usage: true };
  }
  if (params.tools && params.tools.length > 0 && caps?.nativeTools !== false) {
    body.tools = params.tools;
    body.tool_choice = params.toolChoice ?? 'auto'; // the only value all 5 providers accept
    if (params.parallelToolCalls === true && caps?.explicitParallelToolCalls === true) {
      body.parallel_tool_calls = true;
    }
    if (params.toolStream === true && caps?.requireToolStreamFlag === true) {
      body.tool_stream = true;
    }
  }
  return body;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 超时也要说清「是哪个上游 + 等了多久 + 下一步」，避免只剩一句「请稍后重试」。 */
function describeTimeout(baseUrl: string, timeoutMs: number): string {
  const host = upstreamHost(baseUrl);
  // 保留一位小数：1.5s 的配置不该被四舍五入成「2s」，否则用户按文案调参会对不上。
  const seconds = String(Math.round(timeoutMs / 100) / 10);
  return `上游（${host}）在 ${seconds}s 内没有响应（超时）。可稍后重试；若频繁超时请更换上游，或调大环境变量 UPSTREAM_TIMEOUT_MS。`;
}

/** 连接类失败（可重试）：与「上游明确回了 4xx/5xx」区分开，只有前者值得再试。 */
class UpstreamNetworkError extends AppError {
  constructor(message: string) {
    super(ErrorCode.UPSTREAM_ERROR, message);
  }
}

export class OpenAICompatibleAdapter {
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(options: AdapterOptions = {}) {
    this.fetchFn =
      options.fetchFn ??
      ((url: string, init?: RequestInit) =>
        undiciFetch(url, { ...(init ?? {}), dispatcher: LONG_STREAM_DISPATCHER } as unknown as Parameters<typeof undiciFetch>[1]));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = Math.max(0, Math.min(3, options.retries ?? 0));
  }

  private async post(
    params: ChatParams,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        return await this.postOnce(params, body, signal);
      } catch (err) {
        lastError = err;
        // 外部主动中止 / 鉴权失败 / 超时都不重试：重复失败只会延长用户等待。
        const retryable = err instanceof UpstreamNetworkError && !signal?.aborted;
        if (!retryable || attempt === this.retries) throw err;
        await delay(300 * (attempt + 1));
      }
    }
    throw lastError;
  }

  private async postOnce(
    params: ChatParams,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const combined = controller.signal;

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new AppError(ErrorCode.UPSTREAM_TIMEOUT, describeTimeout(params.baseUrl, this.timeoutMs)));
      }, this.timeoutMs);
      timeoutHandle.unref();
    });
    timeoutPromise.catch(() => {});

    try {
      const fetchPromise = this.fetchFn(`${params.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: combined,
      });
      fetchPromise.catch(() => {});
      return await Promise.race([fetchPromise, timeoutPromise]);
    } catch (err) {
      // 外部取消优先：如果把用户中止误报成“超时”，用户会以为上游有问题。
      if (signal?.aborted) throw new AppError(ErrorCode.UPSTREAM_ERROR, '任务已取消（连接已中止）');
      if (err instanceof AppError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppError(ErrorCode.UPSTREAM_TIMEOUT, describeTimeout(params.baseUrl, this.timeoutMs));
      }
      throw new UpstreamNetworkError(
        `无法连接上游（${upstreamHost(params.baseUrl)}）：${maskKey(err instanceof Error ? err.message : String(err), params.apiKey)}。请检查网络/代理，或改用可访问的 Base URL。`,
      );
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // 注意：**不能**在这里 removeEventListener。postOnce 只等到响应头就返回，
      // 之后 streamChat 还要读 body；外部 abort 发生在流式中途时，正是靠这个监听
      // 把本地 controller 中止掉，才能断开 body / 释放上游连接（R5 实测：
      // 提前解绑会让流式中止退化成“等上游自己结束”）。
      // 监听挂在 run 级 signal 上，run 结束整个 signal 即被回收，最多每轮一个。
    }
  }

  /** Non-streaming completion (used by the ReAct channel and probes). */
  async chat(params: ChatParams, caps?: ProviderCapabilities, signal?: AbortSignal): Promise<ChatResult> {
    const response = await this.post(params, buildChatBody({ ...params, stream: false }, caps), signal);
    if (!response.ok) {
      throw new AppError(ErrorCode.UPSTREAM_ERROR, await readErrorBody(response, params.apiKey, params.baseUrl));
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AppError(ErrorCode.UPSTREAM_ERROR, '上游响应解析失败');
    }
    const root = (payload ?? {}) as Record<string, unknown>;
    const choices = root.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new AppError(ErrorCode.UPSTREAM_ERROR, '上游响应缺少 choices 字段');
    }
    const choice = choices[0] as Record<string, unknown>;
    const message = (choice.message ?? {}) as Record<string, unknown>;
    const content = extractContent(message);
    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop';
    const rawUsage = (root.usage ?? {}) as Record<string, unknown>;
    const usage: Usage = {
      promptTokens: typeof rawUsage.prompt_tokens === 'number' ? rawUsage.prompt_tokens : 0,
      completionTokens: typeof rawUsage.completion_tokens === 'number' ? rawUsage.completion_tokens : 0,
    };
    const toolCalls = extractToolCallDeltas(message);
    const acc = createToolCallAccumulator();
    accumulate(acc, toolCalls as Parameters<typeof accumulate>[1]);
    return { content, finishReason, usage, toolCalls: finalize(acc) };
  }

  /** Streaming completion: yields meta/delta/reasoning/tool_calls/done events. */
  async *stream(
    params: ChatParams,
    providerId: string,
    caps?: ProviderCapabilities,
    signal?: AbortSignal,
  ): AsyncGenerator<UpstreamEvent> {
    yield { type: 'meta', provider: providerId, model: params.model };
    const response = await this.post(params, buildChatBody({ ...params, stream: true }, caps), signal);
    // 阶段语义：拿到响应头即「上游已响应」，无论状态码——非 2xx 也说明它不是连不上。
    params.onResponseStart?.();
    if (!response.ok) {
      throw new AppError(ErrorCode.UPSTREAM_ERROR, await readErrorBody(response, params.apiKey, params.baseUrl));
    }
    if (!response.body) {
      throw new AppError(ErrorCode.UPSTREAM_ERROR, '上游未返回响应体');
    }
    yield* parseUpstreamSSE(response.body);
  }

  /**
   * AC-01 capability probe: sends a single-parameter fake tool and inspects the
   * reply. tool_calls in the response → supported; plain text or a rejected
   * `tools` parameter → unsupported; network/auth failure → failed (distinct
   * from unsupported so a flaky key never gets cached as "no function calling").
   */
  async probeToolSupport(params: ChatParams, signal?: AbortSignal): Promise<ProbeOutcome> {
    const probeTool: ProviderToolSpec = {
      type: 'function',
      function: {
        name: '__probe__',
        description: 'Connectivity probe',
        parameters: {
          type: 'object',
          properties: { ping: { type: 'string' } },
          required: ['ping'],
        },
      },
    };

    /**
     * 探测预算：原来是 16 token，但**推理型模型**（带 reasoning_content 的那些）
     * 会先把预算花在思维链上，模型还没输出 tool_calls 就被 `finish_reason: 'length'`
     * 截断。实测某模型 16 token 全被 reasoning 吃掉（reasoning_tokens=192），
     * 于是一个明明支持 function calling 的模型被判成 unsupported。
     * 256 足够产出一个 tool_call，成本可忽略。
     */
    const PROBE_MAX_TOKENS = 256;

    const sendProbe = (toolChoice: 'required' | 'auto') =>
      this.post(
        params,
        buildChatBody(
          { ...params, stream: false, tools: [probeTool], toolChoice, maxTokens: PROBE_MAX_TOKENS },
          undefined,
        ),
        signal,
      );

    if (signal?.aborted) return { status: 'cancelled', evidence: 'aborted' };

    try {
      /**
       * 先用 `required`。
       *
       * `auto` 下模型「可以调但选择不调」——面对一个描述只有 "Connectivity probe"
       * 的假工具，它经常直接回一段文本说明自己不需要调用，于是被判定为
       * 「不支持 function calling」。这两件事必须分开：不会调 ≠ 不支持。
       * `required` 强制它必须给出 tool_calls，才能真正验证能力。
       */
      let response = await sendProbe('required');

      if (response.status === 400) {
        const bodyText = await response.text().catch(() => '');
        // 只拒绝 `tool_choice` 值的 provider（不是拒绝 tools 本身）→ 回退 auto 再试一次。
        // buildChatBody 的注释说明过 auto 是「所有 provider 都接受」的值，不能硬要求 required。
        if (/tool_choice/i.test(bodyText)) {
          response = await sendProbe('auto');
        } else if (/tool|function/i.test(bodyText)) {
          // A 400 that names the tools parameter means the provider rejects them.
          return { status: 'unsupported', evidence: 'tools_param_rejected' };
        } else {
          return { status: 'failed', evidence: 'network', detail: 'HTTP 400' };
        }
      }

      if (!response.ok) {
        const status = response.status;
        if (status === 401 || status === 403) return { status: 'failed', evidence: 'auth', detail: `HTTP ${status}` };
        return { status: 'failed', evidence: 'network', detail: `HTTP ${status}` };
      }

      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const choices = payload?.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        return { status: 'failed', evidence: 'network', detail: 'empty choices' };
      }
      const message = (choices[0] as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
      if (message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        return { status: 'supported', evidence: 'tool_calls_returned' };
      }

      // 被 max_tokens 截断：这是「没探测出来」，不是「不支持」。
      // 报 failed 而不是 unsupported，免得能力表里留下一个错误的结论。
      const finishReason = (choices[0] as Record<string, unknown>)?.finish_reason;
      if (finishReason === 'length') {
        return { status: 'failed', evidence: 'probe_truncated', detail: 'probe hit max_tokens before emitting tool_calls' };
      }

      return { status: 'unsupported', evidence: 'text_response' };
    } catch (err) {
      // 取消不是故障：探测被 abort 时不能返回 failed（会被当成网络问题缓存/展示）。
      if (signal?.aborted) return { status: 'cancelled', evidence: 'aborted' };
      const message = err instanceof Error ? err.message : String(err);
      const authLike = /401|403|unauthor|api key|invalid/i.test(message);
      return { status: 'failed', evidence: authLike ? 'auth' : 'network', detail: maskKey(message, params.apiKey) };
    }
  }
}
