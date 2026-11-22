/**
 * Artifacts controller — P1-6 artifacts 面板的 HTTP 视图（只读）。
 *
 * 两个端点：
 *  - GET /api/v1/sessions/:sessionId/artifacts          → { artifacts: [...] } 元数据列表
 *  - GET /api/v1/sessions/:sessionId/artifacts/:id      → 单条 artifact 元数据 + 正文
 *
 * 权限：与 sessions.detail 同一套规矩（AUDIT-018）——会话绑定了设备令牌哈希时，
 * 请求必须带匹配的 X-Device-Token，否则 403；历史空哈希会话放行。
 *
 * 错误映射：
 *  - 会话不存在            → 404 SESSION_NOT_FOUND
 *  - 越权                  → 403 SESSION_ACCESS_DENIED
 *  - artifact 不存在/无文件 → 404 ARTIFACT_NOT_FOUND
 *  - 路径逃逸              → 400 ARTIFACT_PATH_ESCAPE
 *  - 超大                  → 413 ARTIFACT_TOO_LARGE
 */

import type { Request, Response } from 'express';
import { AppError } from '../utils/errors.js';
import { sha256Hex } from '../utils/hash.js';
import type { SessionRepository, SessionRow } from '../services/memory/session.repository.js';
import {
  ArtifactNotFoundError,
  ArtifactPathEscapeError,
  ArtifactService,
  ArtifactTooLargeError,
} from '../services/artifacts/artifact.service.js';
import { ArtifactIdParamSchema, ArtifactSessionParamSchema } from '../validators/artifact.schema.js';

export class ArtifactsController {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly artifacts: ArtifactService,
  ) {}

  /** AUDIT-018 口径与 SessionsController.assertOwned 一致。 */
  private assertOwned(session: SessionRow, req: Request): void {
    if (!session.device_token_hash) return;
    const deviceHeader = req.header('X-Device-Token');
    const deviceTokenHash = deviceHeader ? sha256Hex(deviceHeader) : null;
    if (deviceTokenHash !== session.device_token_hash) {
      throw new AppError('SESSION_ACCESS_DENIED', '无权访问该会话', 403);
    }
  }

  private loadSession(req: Request): SessionRow {
    const params = ArtifactSessionParamSchema.safeParse(req.params);
    if (!params.success) throw new AppError('VALIDATION_ERROR', 'sessionId 不合法', 400);
    const session = this.sessions.get(params.data.sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', '会话不存在或已被删除', 404);
    this.assertOwned(session, req);
    return session;
  }

  /** GET /sessions/:sessionId/artifacts — 元数据列表（新的在后，按时间线）。 */
  list(req: Request, res: Response): void {
    const session = this.loadSession(req);
    res.json({ sessionId: session.id, artifacts: this.artifacts.list(session.id) });
  }

  /** GET /sessions/:sessionId/artifacts/:id — 单条 artifact 正文。异步读盘，rejection 交给 next。 */
  async detail(req: Request, res: Response): Promise<void> {
    const params = ArtifactIdParamSchema.safeParse(req.params);
    if (!params.success) throw new AppError('VALIDATION_ERROR', '参数不合法', 400);
    const session = this.loadSession(req);
    const resultId = params.data.id;
    try {
      const artifact = await this.artifacts.get(session.id, resultId);
      res.json({ sessionId: session.id, artifact });
    } catch (err) {
      if (err instanceof ArtifactNotFoundError) {
        throw new AppError('ARTIFACT_NOT_FOUND', err.message, 404);
      }
      if (err instanceof ArtifactPathEscapeError) {
        throw new AppError('ARTIFACT_PATH_ESCAPE', err.message, 400);
      }
      if (err instanceof ArtifactTooLargeError) {
        throw new AppError('ARTIFACT_TOO_LARGE', err.message, 413);
      }
      throw err;
    }
  }
}
