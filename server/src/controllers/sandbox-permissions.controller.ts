/**
 * Sandbox permissions controller: GET 当前配置 / PUT 更新（allowDirs + autoApprove）。
 * PUT 会做服务端硬校验（绝对路径 / 真实目录 / 非沙箱及祖先 / 非系统敏感目录 / 防 symlink 逃逸）；
 * 任一目录被拒则整体 422 拒绝（不部分写入）。
 */

import type { Request, Response } from 'express';
import { AppError } from '../utils/errors.js';
import type { SandboxPermissionService } from '../services/tools/sandbox-permission.service.js';
import { SandboxPermissionUpdateSchema } from '../validators/sandbox-permission.schema.js';

export class SandboxPermissionsController {
  constructor(private readonly service: SandboxPermissionService) {}

  get(_req: Request, res: Response): void {
    res.json(this.service.getConfig());
  }

  put(req: Request, res: Response): void {
    const parsed = SandboxPermissionUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', `参数不合法：${parsed.error.issues.map((i) => i.message).join('；')}`, 400);
    }
    const result = this.service.update(parsed.data);
    if (!result.ok) {
      // 整体拒绝：返回被拒目录及原因，由前端高亮展示。
      res.status(422).json({
        error: 'INVALID_ALLOW_DIRS',
        message: '以下目录未通过服务端安全校验，已整体拒绝（未写入任何变更）',
        rejected: result.rejected,
      });
      return;
    }
    res.json(this.service.getConfig());
  }
}
