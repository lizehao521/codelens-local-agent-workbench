/**
 * Channel B — ReAct fallback for models without native function calling (AC-01).
 * The tool catalogue is embedded in the system prompt; the model answers with
 * XML-style <tool_call>{"tool":...,"arguments":{...}} blocks, parsed by the
 * three-level react-parser. Cards are labeled "提示词解析模式" on the client.
 */

import type { OpenAICompatibleAdapter } from '../../providers/openai-compatible.adapter.js';
import type { ProviderCapabilities, UpstreamMessage, Usage } from '../../types/index.js';
import type { ToolDefinition } from '../../types/tool.js';
import type { SseWriter } from './sse-writer.js';
import type { TurnIR } from './turn-ir.js';
import { parseReactOutput } from './react-parser.js';

export interface ReactTurnContext {
  adapter: OpenAICompatibleAdapter;
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: UpstreamMessage[];
  tools: ToolDefinition[];
  temperature: number;
  maxTokens: number;
  /** Provider 能力（含 NVIDIA 的 supportsSystemRole=false），用于 buildChatBody 适配。 */
  capabilities?: ProviderCapabilities;
  sse: SseWriter;
  signal: AbortSignal;
  /** R3：上游返回响应头时回调（阶段归因用）。 */
  onResponseStart?: () => void;
  /** B-07：上游首个内容块到达时回调一次（用于测首 token 延迟 + 阶段归因）。 */
  onFirstToken?: (kind: 'reasoning' | 'content') => void;
}

/** Renders the tool catalogue for the ReAct system prompt. */
export function renderToolCatalogue(tools: ToolDefinition[]): string {
  return tools
    .map((tool) => {
      const props = Object.entries(tool.inputSchema.properties ?? {})
        .map(([key, schema]) => {
          const required = tool.inputSchema.required?.includes(key) ? '（必填）' : '';
          const desc = typeof schema.description === 'string' ? `：${schema.description}` : '';
          return `    - ${key}${required}${desc}`;
        })
        .join('\n');
      return `- ${tool.name}（${tool.displayName}）：${tool.description}\n  参数：\n${props || '    （无参数）'}`;
    })
    .join('\n');
}

/**
 * baseSystem 为 buildView 合成的基座提示词（身份 + 工作方式 + 任务段）。传入时叠加
 * 文本协议段而不是整体替换——否则降级到本通道的任务会丢失任务模式与最终答案契约
 * （native/react 两通道共享同一提示词闭环）。缺省时回退到独立身份行（向后兼容）。
 */
export function buildReactSystemPrompt(catalogue: string, baseSystem?: string): string {
  const identity = baseSystem?.trim()
    ? baseSystem.trim()
    : '你是一个通过工具完成任务的 Agent。';
  return [
    identity,
    '',
    '【文本协议】当前模型不支持原生 function calling，使用以下文本协议调用工具。',
    '',
    '【可用工具】',
    catalogue,
    '',
    '【调用格式】需要调用工具时，必须且只能输出：',
    'TOOL_CALL_OPEN{"tool":"工具名","arguments":{"参数名":"参数值"}}TOOL_CALL_CLOSE',
    '可连续输出多个调用块。不需要调用工具时，直接输出最终答案文本。',
    '',
    '【协议规则】',
    '1. 工具名必须与【可用工具】中的完全一致，禁止编造。',
    '2. arguments 必须是合法 JSON 对象，字符串用双引号。',
    '3. 每次只调用当前步骤需要的工具，拿到结果后再决定下一步。',
    '4. 任务完成时按【表达与版式】自适应输出最终答案，不要套固定模板，也不要再调用工具。',
  ]
    .join('\n')
    .replace(/TOOL_CALL_OPEN/g, String.fromCharCode(60) + 'tool_call' + String.fromCharCode(62))
    .replace(/TOOL_CALL_CLOSE/g, String.fromCharCode(60) + '/tool_call' + String.fromCharCode(62));
}
export async function runReactTurn(ctx: ReactTurnContext): Promise<TurnIR> {
  const catalogue = renderToolCatalogue(ctx.tools);
  const baseSystem = ctx.messages.find((message) => message.role === 'system')?.content;
  const reactSystem = buildReactSystemPrompt(catalogue, baseSystem);
  const messages: UpstreamMessage[] = [
    { role: 'system', content: reactSystem },
    ...ctx.messages.filter((message) => message.role !== 'system'),
  ];

  let text = '';
  let usage: Usage = { promptTokens: 0, completionTokens: 0 };
  const warnings: string[] = [];
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
      messages,
      temperature: ctx.temperature,
      maxTokens: ctx.maxTokens,
      stream: true,
      onResponseStart: ctx.onResponseStart,
    },
    ctx.providerId,
    ctx.capabilities,
    ctx.signal,
  );

  for await (const event of stream) {
    if (event.type === 'delta') {
      markFirstToken('content');
      text += event.text;
      ctx.sse.emit('delta', { text: event.text });
    } else if (event.type === 'reasoning') {
      markFirstToken('reasoning');
      ctx.sse.emit('reasoning', { text: event.text });
    } else if (event.type === 'done') {
      usage = event.usage;
    }
  }

  const parsed = parseReactOutput(text);
  const toolCalls: TurnIR['toolCalls'] = [];
  if (parsed.kind === 'calls') {
    for (const call of parsed.toolCalls) {
      toolCalls.push({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        rawArguments: call.rawArguments,
        channel: 'react',
      });
    }
    warnings.push(...parsed.warnings);
  } else if (parsed.kind === 'invalid') {
    warnings.push(parsed.error.message);
    return {
      text,
      reasoning: '',
      toolCalls: [
        {
          id: `call_react_invalid_${Date.now().toString(36)}`,
          name: '__invalid__',
          arguments: {},
          rawArguments: '',
          channel: 'react',
          parseError: 'INVALID_JSON',
        },
      ],
      finishReason: 'tool_calls',
      warnings,
      usage,
    };
  }

  const finishReason: TurnIR['finishReason'] = toolCalls.length > 0 ? 'tool_calls' : 'stop';
  return {
    text: parsed.kind === 'calls' ? parsed.text : text,
    reasoning: '',
    toolCalls,
    finishReason,
    warnings,
    usage,
  };
}
