/**
 * MCP server config store: JSON file at <server root>/config/mcp-servers.json.
 * No table in the DB (spec 6: config is operational, not audit data). Env values
 * are persisted but NEVER returned by the API (secret hygiene, spec 7.6.4).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  enabled: boolean;
}

interface ConfigFile {
  servers: McpServerConfig[];
}

/**
 * 当前模块所在目录。打包态（esbuild cjs bundle）import.meta.url 为空会抛错，
 * 返回 cwd 兜底；桌面态由 MCP_CONFIG_PATH env 指定可写位置，不会走到这里。
 */
function moduleDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

function configPath(): string {
  let dir = moduleDir();
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return path.join(dir, 'config', 'mcp-servers.json');
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(dir, 'config', 'mcp-servers.json');
    dir = parent;
  }
}

export class McpConfigStore {
  private readonly file: string;

  constructor(filePath?: string) {
    this.file = filePath ?? configPath();
  }

  load(): McpServerConfig[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as ConfigFile;
      return Array.isArray(parsed.servers) ? parsed.servers : [];
    } catch {
      return [];
    }
  }

  private save(servers: McpServerConfig[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ servers } satisfies ConfigFile, null, 2)}\n`, 'utf8');
  }

  get(id: string): McpServerConfig | undefined {
    return this.load().find((server) => server.id === id);
  }

  add(config: Omit<McpServerConfig, 'enabled'> & { enabled?: boolean }): McpServerConfig {
    const servers = this.load();
    if (servers.some((server) => server.id === config.id)) {
      throw new Error(`MCP server already exists: ${config.id}`);
    }
    const entry: McpServerConfig = { ...config, enabled: config.enabled ?? false };
    servers.push(entry);
    this.save(servers);
    return entry;
  }

  patch(id: string, fields: Partial<Omit<McpServerConfig, 'id'>>): McpServerConfig | undefined {
    const servers = this.load();
    const index = servers.findIndex((server) => server.id === id);
    if (index < 0) return undefined;
    servers[index] = { ...servers[index]!, ...fields, id };
    this.save(servers);
    return servers[index];
  }

  remove(id: string): boolean {
    const servers = this.load();
    const next = servers.filter((server) => server.id !== id);
    if (next.length === servers.length) return false;
    this.save(next);
    return true;
  }
}
