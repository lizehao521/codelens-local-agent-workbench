/**
 * Channel A — native function calling: upstream stream → TurnIR.
 * Deltas/reasoning stream straight to the browser; tool_calls arrive once,
 * complete, at the end of the stream (tool-call-normalizer).
 */

import type { OpenAICompatibleAdapter } from '../../providers/openai-compatible.adapter.js';
import type { ProviderToolSpec, UpstreamMessage, Usage } from '../../types/index.js';
import type { ProviderCapabilities } from '../../types/index.js';
import type { SseWriter } from './sse-writer.js';
import type { TurnIR } from './turn-ir.js';

export interface NativeTurnContext {
  adapter: OpenAICompatibleAdapter;
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: UpstreamMessage[];
  tools: ProviderToolSpec[];
  temperature: number;
  maxTokens: number;
  capabilities: ProviderCapabilities;
  sse: SseWriter;
  signal: AbortSignal;
  /** R3：上游返回响应头时回调（阶段归因用）。 */
  onResponseStart?: () => void;
  /** B-07：上游首个内容块到达时回调一次（用于测首 token 延迟 + 阶段归因）。 */
  onFirstToken?: (kind: 'reasoning' | 'content') => void;
}

export async function runNativeTurn(ctx: NativeTurnContext): Promise<TurnIR> {
  let text = '';
  let reasoning = '';
  const toolCalls: TurnIR['toolCalls'] = [];
  const warnings: string[] = [];
  let finishReason: TurnIR['finishReason'] = 'stop';
  let usage: Usage = { promptTokens: 0, completionTokens: 0 };
  let firstTokenFired = false;
  const markFirstToken = (kind: 'reasoning' | 'content'): void => {
    if (!firstTokenFired) {
      firstTokenFired = true;
      ctx.onFirstToken?.(kind);
    }
  };

  const stream = ctx.adapter.stream(
    {
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      model: ctx.model,
      messages: ctx.messages,
      temperature: ctx.temperature,
      maxTokens: ctx.maxTokens,
      stream: true,
      tools: ctx.tools,
      toolChoice: 'auto',
      parallelToolCalls: false,
      toolStream: ctx.capabilities.requireToolStreamFlag,
      onResponseStart: ctx.onResponseStart,
    },
    ctx.providerId,
    ctx.capabilities,
    ctx.signal,
  );

  for await (const event of stream) {
    switch (event.type) {
      case 'delta':
        markFirstToken('content');
        text += event.text;
        ctx.sse.emit('delta', { text: event.text });
        break;
      case 'reasoning':
        markFirstToken('reasoning');
        reasoning += event.text;
        ctx.sse.emit('reasoning', { text: event.text });
        break;
      case 'tool_calls':
        markFirstToken('content');
        for (const call of event.calls) {
          if (call.parseError === 'MISSING_ID') {
            warnings.push(`工具调用缺少 id，服务端已生成兜底 id（${call.name || 'unknown'}）`);
          }
          toolCalls.push({
            id: call.id || `call_${Math.random().toString(36).slice(2, 12)}`,
            name: call.name,
            arguments: call.arguments,
            rawArguments: call.rawArguments,
            channel: 'native',
            parseError: call.parseError,
          });
        }
        break;
      case 'done':
        finishReason =
          event.finishReason === 'tool_calls'
            ? 'tool_calls'
            : event.finishReason === 'length'
              ? 'length'
              : event.finishReason === 'content_filter'
                ? 'content_filter'
                : 'stop';
        usage = event.usage;
        break;
      default:
        break;
    }
  }

  if (toolCalls.length > 0) finishReason = 'tool_calls';
  if (toolCalls.some((call) => call.parseError === 'INVALID_JSON')) {
    warnings.push('部分工具调用的参数 JSON 不完整，将按失败回喂');
  }
  return { text, reasoning, toolCalls, finishReason, warnings, usage };
}
