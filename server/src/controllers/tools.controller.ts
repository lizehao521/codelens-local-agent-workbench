/** Tools controller: registry listing (risk-grouped) and enable/disable overrides. */

import type { Request, Response } from 'express';
import { AppError } from '../utils/errors.js';
import type { ToolRegistry } from '../services/tools/registry.service.js';
import { PatchToolSchema, ToolListQuerySchema, ToolNameParamSchema } from '../validators/tools.schema.js';

export class ToolsController {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly sandboxRoot: string,
  ) {}

  private enableCtx() {
    return { sandboxRoot: this.sandboxRoot, mcpConnected: false };
  }

  list(req: Request, res: Response): void {
    const parsed = ToolListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', '过滤参数不合法', 400);
    const tools = this.registry.listPublic(this.enableCtx(), parsed.data);
    const grouped: Record<'low' | 'medium' | 'high', string[]> = { low: [], medium: [], high: [] };
    for (const tool of tools) grouped[tool.risk].push(tool.name);
    res.json({ tools, grouped });
  }

  patch(req: Request, res: Response): void {
    const params = ToolNameParamSchema.safeParse(req.params);
    if (!params.success) throw new AppError('VALIDATION_ERROR', '工具名必须为点号规范名（如 fs.read）', 400);
    const parsed = PatchToolSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'enabled 必须为布尔值', 400);
    if (!this.registry.get(params.data.name)) {
      throw new AppError('TOOL_NOT_FOUND', `工具 ${params.data.name} 不在注册表中`, 404);
    }
    this.registry.setEnabled(params.data.name, parsed.data.enabled);
    res.json({ name: params.data.name, enabled: parsed.data.enabled });
  }
}
