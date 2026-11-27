/**
 * RSI Apply/Verify/Proposals Routes — Minis 侧写入/验收闭环的 HTTP 端点。
 *
 * 挂载点：/api/v1/rsi
 *   POST   /apply-patch     -> RsiApplyController.applyPatch
 *   POST   /verify          -> RsiVerifyController.verify
 *   GET    /proposals/:id   -> 查看提案详情（从共享存储读取）
 */

import { Router } from 'express';
import type { RsiApplyController } from '../controllers/rsi-apply.controller.js';
import type { RsiVerifyController } from '../controllers/rsi-verify.controller.js';
import type { Db } from '../repositories/db.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../..', import.meta.url));
const WORK = path.resolve(SERVER, '..', '.self-upgrade');
const PROPOSALS_DIR = path.join(WORK, 'proposals');

export function createRsiApplyRoutes(
  applyController: RsiApplyController,
  verifyController: RsiVerifyController,
  db: Db
): Router {
  const router = Router();

  // POST /api/v1/rsi/apply-patch
  router.post('/apply-patch', (req, res) => applyController.applyPatch(req, res));

  // POST /api/v1/rsi/verify
  router.post('/verify', (req, res) => verifyController.verify(req, res));

  // GET /api/v1/rsi/proposals/:id
  router.get('/proposals/:id', (req, res) => {
    const id = req.params.id;
    if (!id || id.length > 128) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '无效的 proposalId' } });
      return;
    }

    const proposalPath = path.join(PROPOSALS_DIR, `${id}.json`);
    if (!existsSync(proposalPath)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `提案不存在：${id}` } });
      return;
    }

    try {
      const content = readFileSync(proposalPath, 'utf8');
      const proposal = JSON.parse(content);
      res.json(proposal);
    } catch (e) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '读取提案失败' } });
    }
  });

  return router;
}

/**
 * 供 Minis 推送提案制品时调用的内部函数（不暴露为 HTTP 端点）。
 * 将提案完整制品写入 .self-upgrade/proposals/{id}.json
 */
export async function storeProposalArtifact(
  proposalId: string,
  artifact: Record<string, unknown>
): Promise<void> {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  const proposalPath = path.join(PROPOSALS_DIR, `${proposalId}.json`);
  writeFileSync(proposalPath, JSON.stringify(artifact, null, 2), 'utf8');
}