/**
 * 可编程 fake OpenAI-compatible LLM 服务（测试夹具）。
 *
 * 从 agent-loop-e2e.test.ts 抽出：闭环演练（closure-drill）需要同一种
 * 「逐轮脚本化 tool_calls」的假上游，而复制一份 200 行的 SSE 拼装逻辑会让
 * 两处慢慢漂移 —— 一旦夹具行为不一致，「e2e 过了但演练挂了」将无法归因。
 *
 * 只做上游该做的事：接受 chat/completions、按脚本回 JSON 或 SSE、
 * 记录收到的请求体（供断言 system prompt 是否带上了 π 经验）。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeStep {
  toolCall?: { id: string; name: string; arguments: string };
  text?: string;
  /** 只输出推理、没有正文（模拟 reasoning 型模型）。 */
  reasoning?: string;
  /** 收尾原因；默认 stop。设为 length 可模拟「推理吃满输出预算」。 */
  finishReason?: string;
  /** P0-1: deliver a usage-bearing chunk, then stall the stream forever. */
  hang?: boolean;
  /** R3: accept the request but never even send response headers（模拟上游长尾无响应）。 */
  stall?: boolean;
}

export interface SseEvent {
  name: string;
  data: any;
}

export class FakeLlm {
  readonly requests: Array<Record<string, any>> = [];
  /** R3：被调用方中止（连接在响应结束前关闭）的请求数——验证 AbortController 确实贯通到上游。 */
  abortedRequests = 0;
  /** R3：最近一次上游观察到连接被中止的时间（epoch ms）。 */
  lastAbortAt: number | null = null;
  /** R5：能力探测请求数（与生成请求分开计，`__probe__` 标记）。 */
  probeRequests = 0;
  /** R5：探测请求永不回应——用来测「等首事件期间中止」时探测是否随 signal 取消。 */
  probeStall = false;
  private steps: FakeStep[] = [];
  private readonly server: http.Server;

  private constructor(server: http.Server) {
    this.server = server;
    server.on('request', (req, res) => void this.handle(req, res));
  }

  static async start(): Promise<FakeLlm> {
    const server = http.createServer();
    const fake = new FakeLlm(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return fake;
  }

  get baseUrl(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/v1`;
  }

  script(steps: FakeStep[]): void {
    this.steps = steps;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  /** 最近一次请求的 system 消息原文（断言 π 注入用）。 */
  lastSystemPrompt(): string {
    for (let i = this.requests.length - 1; i >= 0; i -= 1) {
      const messages = this.requests[i]?.messages;
      if (!Array.isArray(messages)) continue;
      const system = messages.find((m: any) => m?.role === 'system');
      if (system) return String(system.content ?? '');
    }
    return '';
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    // 连接在响应写完前关闭 = 调用方中止了上游请求。
    res.on('close', () => {
      if (!res.writableEnded) {
        this.abortedRequests += 1;
        this.lastAbortAt = Date.now();
      }
    });
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":{"message":"not found"}}');
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let payload: Record<string, any>;
      try {
        payload = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":{"message":"bad json"}}');
        return;
      }
      this.requests.push(payload);

      const tools = Array.isArray(payload.tools) ? payload.tools : [];
      const isProbe = tools.some((t: any) => t?.function?.name === '__probe__');
      if (isProbe) {
        this.probeRequests += 1;
        // 探测长尾：收到请求但永不回响应头，调用方中止时应立刻断开。
        if (this.probeStall) return;
        this.replyProbe(res);
        return;
      }
      if (payload.stream === true) {
        this.replyStream(res);
        return;
      }
      this.replyJson(res);
    });
  }

  /** AC-01 probe: tool_calls in the reply means "function calling supported". */
  private replyProbe(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-probe',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_probe', type: 'function', function: { name: '__probe__', arguments: '{"ping":"p"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      }),
    );
  }

  private nextStep(): FakeStep {
    return this.steps.shift() ?? { text: '（脚本步骤已用尽，返回兜底文本）' };
  }

  private replyJson(res: http.ServerResponse): void {
    const step = this.nextStep();
    if (step.hang) {
      // 非流式的「上游不响应」：收到请求但永不写回，用来验证调用方自己的
      // 计时器确实生效（探活/深判这类一次性调用走的是非流式路径）。
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        choices: [
          { index: 0, message: { role: 'assistant', content: step.text ?? '' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
      }),
    );
  }

  private replyStream(res: http.ServerResponse): void {
    const step = this.nextStep();
    if (step.stall) {
      // R3 长尾场景：请求已收到，但连响应头都不回——调用方应靠早事件而不是静默等待。
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const chunk = (obj: unknown): void => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    if (step.hang) {
      // P0-1 scenario: the usage chunk arrives (the provider will bill it),
      // then the connection stalls. The test aborts the run mid-stream.
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '开始处理' } }] });
      chunk({ choices: [], usage: { prompt_tokens: 555, completion_tokens: 7, total_tokens: 562 } });
      return; // never end the response
    }
    if (step.toolCall) {
      // Name/id in the first fragment, arguments split across two more — this
      // exercises the tool-call-normalizer's fragment accumulation.
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: step.toolCall.id,
                  type: 'function',
                  function: { name: step.toolCall.name, arguments: '' },
                },
              ],
            },
          },
        ],
      });
      const argsJson = step.toolCall.arguments;
      const mid = Math.max(1, Math.floor(argsJson.length / 2));
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(0, mid) } }] } }] });
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(mid) } }] } }] });
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      });
    } else {
      if (step.reasoning) {
        chunk({
          choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: step.reasoning } }],
        });
      }
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: step.text ?? '' } }] });
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: step.finishReason ?? 'stop' }],
        usage: { prompt_tokens: 160, completion_tokens: 12, total_tokens: 172 },
      });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
}
