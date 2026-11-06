/**
 * Capabilities controller：只读返回「运行时能力开关目录」。
 *
 * 只有一个动作（GET 列表），没有写端点 —— 它是观测面，不是配置面：
 * 想改某个能力的状态，去改它自己的配置来源（env / sandbox-permissions 等），
 * 而不是让这个端点去改。旧一代的 `/api/v1/insights/capabilities` 就是这个定位。
 */

import type { Request, Response } from 'express';
import type { CapabilityRegistryService } from '../services/capability/capability-registry.service.js';

export class CapabilitiesController {
  constructor(private readonly registry: CapabilityRegistryService) {}

  list(_req: Request, res: Response): void {
    res.json(this.registry.list());
  }
}
