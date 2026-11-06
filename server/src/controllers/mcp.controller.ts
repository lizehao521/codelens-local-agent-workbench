/**
 * MCP connector controller (P1): CRUD + connect/disconnect.
 * Env values are never echoed back (secret hygiene, spec 7.6.4).
 */

import type { Request, Response } from 'express';
import { AppError } from '../utils/errors.js';
import type { McpConfigStore } from '../services/mcp/mcp-config.store.js';
import type { McpManagerService } from '../services/mcp/mcp-manager.service.js';
import {
  CreateMcpServerSchema,
  McpServerIdParamSchema,
  PatchMcpServerSchema,
} from '../validators/mcp.schema.js';

export class McpController {
  constructor(
    private readonly store: McpConfigStore,
    private readonly manager: McpManagerService,
  ) {}

  private view(config: { id: string; name: string; command: string; args: string[]; cwd?: string; enabled: boolean }) {
    const status = this.manager.statusOf(config.id);
    return {
      id: config.id,
      name: config.name,
      command: config.command,
      args: config.args,
      cwd: config.cwd ?? null,
      enabled: config.enabled,
      status,
      tools: this.manager.toolsOf(config.id),
      lastError: null,
      connectedAt: status === 'connected' ? Date.now() : null,
    };
  }

  list(_req: Request, res: Response): void {
    const servers = this.store.load().map((config) => this.view(config));
    res.json({ servers });
  }

  create(req: Request, res: Response): void {
    // 注意：不要向 .strict() 的 schema 注入 id——schema 无此字段，
    // 注入会让每一次创建都败在 "Unrecognized key"（E2E 实测教训）。
    // id 由 name slug 化派生，见下方 slugify。
    const parsed = CreateMcpServerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；'), 400);
    }
    const id = slugify(parsed.data.name);
    try {
      const config = this.store.add({
        id,
        name: parsed.data.name,
        command: parsed.data.command,
        args: parsed.data.args,
        env: parsed.data.env,
        cwd: parsed.data.cwd,
      });
      res.status(201).json({ server: this.view(config) });
    } catch (err) {
      throw new AppError('VALIDATION_ERROR', err instanceof Error ? err.message : '创建失败', 409);
    }
  }

  patch(req: Request, res: Response): void {
    const params = McpServerIdParamSchema.safeParse(req.params);
    if (!params.success) throw new AppError('VALIDATION_ERROR', 'serverId 不合法', 400);
    const parsed = PatchMcpServerSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', '至少提供一个字段', 400);
    const config = this.store.patch(params.data.id, parsed.data);
    if (!config) throw new AppError('MCP_SERVER_NOT_FOUND', 'MCP Server 配置不存在', 404);
    res.json({ server: this.view(config) });
  }

  async remove(req: Request, res: Response): Promise<void> {
    const params = McpServerIdParamSchema.safeParse(req.params);
    if (!params.success) throw new AppError('VALIDATION_ERROR', 'serverId 不合法', 400);
    await this.manager.disconnect(params.data.id);
    if (!this.store.remove(params.data.id)) {
      throw new AppError('MCP_SERVER_NOT_FOUND', 'MCP Server 配置不存在', 404);
    }
    res.json({ deleted: true, id: params.data.id });
  }

  async connect(req: Request, res: Response): Promise<void> {
    const params = McpServerIdParamSchema.safeParse(req.params);
    if (!params.success) throw new AppError('VALIDATION_ERROR', 'serverId 不合法', 400);
    if (!this.store.get(params.data.id)) {
      throw new AppError('MCP_SERVER_NOT_FOUND', 'MCP Server 配置不存在', 404);
    }
    const result = await this.manager.connect(params.data.id);
    if (result.status === 'failed') {
      throw new AppError('MCP_CONNECT_FAILED', `连接失败：${result.error ?? '未知错误'}`, 502);
    }
    const config = this.store.get(params.data.id)!;
    res.json({ server: this.view({ ...config, enabled: true }) });
  }

  async disconnect(req: Request, res: Response): Promise<void> {
    const params = McpServerIdParamSchema.safeParse(req.params);
    if (!params.success) throw new AppError('VALIDATION_ERROR', 'serverId 不合法', 400);
    if (!this.store.get(params.data.id)) {
      throw new AppError('MCP_SERVER_NOT_FOUND', 'MCP Server 配置不存在', 404);
    }
    const result = await this.manager.disconnect(params.data.id);
    const config = this.store.get(params.data.id)!;
    res.json({ server: { ...this.view(config), status: result.status, tools: result.tools } });
  }
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      // 规范名分段只允许 [a-z0-9_]（CANONICAL_NAME_RE），连字符统一转下划线，
      // 否则 mcp.<id>.<tool> 注册即抛 invalid canonical tool name。
      .replace(/-/g, '_')
      .slice(0, 48) || 'server'
  );
}
