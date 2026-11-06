/**
 * MCP manager: Client lifecycle per server (stdio only — remote MCP is out of
 * scope, spec 3). Spawn uses shell:false; the LLM key is never inherited.
 * Connection failures never affect builtin tools (AC-12 / S-5).
 */

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { ToolRegistry } from '../tools/registry.service.js';
import type { McpConfigStore, McpServerConfig } from './mcp-config.store.js';
import { adaptMcpTool } from './mcp-tool-adapter.js';

export type McpStatus = 'disconnected' | 'connecting' | 'connected' | 'failed';

interface LiveServer {
  client: Client;
  transport: StdioClientTransport;
  tools: string[];
}

export class McpManagerService {
  private readonly live = new Map<string, LiveServer>();

  constructor(
    private readonly store: McpConfigStore,
    private readonly registry: ToolRegistry,
  ) {}

  isConnected(serverId: string): boolean {
    return this.live.has(serverId);
  }

  /** Canonical tool names currently registered for a connected server. */
  toolsOf(serverId: string): string[] {
    return this.live.get(serverId)?.tools ?? [];
  }

  statusOf(serverId: string): McpStatus {
    return this.live.has(serverId) ? 'connected' : 'disconnected';
  }

  /** Connects (or reconnects) a server and registers its tools. */
  async connect(serverId: string): Promise<{ status: McpStatus; tools: string[]; error?: string }> {
    const config: McpServerConfig | undefined = this.store.get(serverId);
    if (!config) return { status: 'failed', tools: [], error: 'MCP_SERVER_NOT_FOUND' };
    if (this.live.has(serverId)) {
      return { status: 'connected', tools: this.live.get(serverId)!.tools };
    }
    try {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...scrubEnv(process.env), ...config.env },
        cwd: config.cwd,
        stderr: 'ignore',
      });
      const client = new Client({ name: 'codelens-agent', version: '2.0.0' });
      await client.connect(transport);
      const listed = await client.listTools();
      const tools: string[] = [];
      for (const tool of listed.tools) {
        const def = adaptMcpTool(serverId, tool, this);
        if (def) {
          this.registry.register(def, { overwrite: true });
          tools.push(def.name);
        }
      }
      this.live.set(serverId, { client, transport, tools });
      return { status: 'connected', tools };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 'failed', tools: [], error: message.slice(0, 300) };
    }
  }

  /** Disconnects and unregisters the server's tools (they vanish for the model). */
  async disconnect(serverId: string): Promise<{ status: McpStatus; tools: string[] }> {
    const live = this.live.get(serverId);
    if (live) {
      try {
        await live.client.close();
      } catch {
        // transport teardown is best-effort
      }
      this.live.delete(serverId);
    }
    this.registry.unregisterByMcpServer(serverId);
    return { status: 'disconnected', tools: [] };
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: Array<Record<string, unknown>>; isError: boolean }> {
    const live = this.live.get(serverId);
    if (!live) throw new Error(`MCP server ${serverId} is not connected`);
    const result = await live.client.callTool({ name: toolName, arguments: args }, { signal });
    return { content: result.content ?? [], isError: result.isError === true };
  }

  /** Health snapshot for GET /api/health. */
  health(): { servers: number; healthy: number } {
    let servers = 0;
    let healthy = 0;
    for (const config of this.store.load()) {
      servers += 1;
      if (this.live.has(config.id)) healthy += 1;
    }
    return { servers, healthy };
  }

  /** Closes every live client (process shutdown). */
  async closeAll(): Promise<void> {
    for (const serverId of [...this.live.keys()]) {
      await this.disconnect(serverId);
    }
  }
}

/** Strips secrets from the inherited environment before spawning a child. */
function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/key|token|secret|password|auth/i.test(key)) continue;
    out[key] = value;
  }
  // Keep PATH and platform essentials so `npx` resolves.
  for (const key of ['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP']) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  return out;
}
