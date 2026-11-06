#!/usr/bin/env node
/**
 * 测试用 MCP stdio 服务器（fake-mcp-server）。
 * 手搓实现 MCP 协议的 stdio 传输子集：换行分隔的 JSON-RPC 2.0。
 * 只实现 manager 实际用到的面：initialize / notifications/initialized /
 * ping / tools/list / tools/call，其余带 id 的请求回 -32601。
 *
 * 暴露三个工具：
 *  - echo       回显 text（annotations: readOnlyHint → low/none）
 *  - add       两数求和（annotations: readOnlyHint → low/none）
 *  - env_probe 报告子进程可见的环境变量（无 annotations → 默认写档 medium/soft）
 *
 * 注意：不要放 inputSchema.type !== 'object' 的工具——MCP SDK 在协议层
 * （ToolSchema 校验）就会拒绝，导致整个 listTools 失败。适配器里的
 * toJsonSchemaSubset 防线由 mcp-connector.test.ts 直接单测覆盖。
 */

const TOOLS = [
  {
    name: 'echo',
    description: '回显输入的文本',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的内容' } },
      required: ['text'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add',
    description: '两数求和',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'env_probe',
    description: '报告子进程环境变量可见性',
    inputSchema: { type: 'object', properties: {} },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function methodNotFound(id, method) {
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

function toolText(id, text, isError = false) {
  result(id, { content: [{ type: 'text', text }], isError });
}

function handleCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (name === 'echo') {
    toolText(id, `echo: ${String(args.text ?? '')}`);
    return;
  }
  if (name === 'add') {
    const a = Number(args.a);
    const b = Number(args.b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      toolText(id, 'add 需要数值参数 a 和 b', true);
      return;
    }
    toolText(id, `sum: ${a + b}`);
    return;
  }
  if (name === 'env_probe') {
    toolText(
      id,
      JSON.stringify({
        SECRET_KEY: process.env.SECRET_KEY ?? null,
        SUPER_SECRET_TOKEN: process.env.SUPER_SECRET_TOKEN ?? null,
      }),
    );
    return;
  }
  toolText(id, `unknown tool: ${String(name)}`, true);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf('\n');
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    const isNotification = message.id === undefined;
    switch (message.method) {
      case 'initialize':
        // 回显客户端请求的协议版本（测试替身最稳的协商策略）
        result(message.id, {
          protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp-server', version: '1.0.0' },
        });
        break;
      case 'notifications/initialized':
        break; // 通知，无响应
      case 'ping':
        if (!isNotification) result(message.id, {});
        break;
      case 'tools/list':
        if (!isNotification) result(message.id, { tools: TOOLS });
        break;
      case 'tools/call':
        if (!isNotification) handleCall(message.id, message.params);
        break;
      default:
        if (!isNotification) methodNotFound(message.id, message.method);
        break;
    }
  }
});
process.stdin.on('end', () => process.exit(0));
