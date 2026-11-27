/**
 * RSI Proposals Controller —— 提案制品存储与查询（Minis ↔ CodeLens 闭环）。
 *
 * 端点：
 *   POST /api/v1/rsi/proposals        -> 存储提案制品（Minis 推送）
 *   GET  /api/v1/rsi/proposals/:id    -> 读取提案制品（前端/Minis 查询）
 *
 * 存储位置：.self-upgrade/proposals/{id}.json
 * 复用 rsi-apply.routes.ts 中的 storeProposalArtifact 内部逻辑。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Db } from '../repositories/db.js';
import { AppError, ErrorCode } from '../utils/errors.js';

const SERVER = fileURLToPath(new URL('../..', import.meta.url));
const WORK = path.resolve(SERVER, '..', '.self-upgrade');
const PROPOSALS_DIR = path.join(WORK, 'proposals');
const LEDGER = path.join(WORK, 'ledger.jsonl');

const StoreProposalSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(['patch', 'skill', 'eval']),
  targetPath: z.string().min(1).max(512),
  patch: z.string().optional(),
  code: z.string().optional(),
  meta: z.object({
    score: z.number(),
    evidence: z.array(z.object({
      type: z.string(),
      description: z.string(),
      data: z.record(z.string(), z.unknown()).optional(),
    })),
    mutationKillRate: z.number(),
    generatedAt: z.string(),
    strategy: z.string(),
  }),
});

type StoreProposalInput = z.infer<typeof StoreProposalSchema>;

export class RsiProposalsController {
  constructor(private readonly db: Db) {}

  // POST /api/v1/rsi/proposals - 存储提案制品
  storeProposal(req: Request, res: Response): void {
    const parse = StoreProposalSchema.safeParse(req.body);
    if (!parse.success) {
      const messages = parse.error.issues.map((e: { message: string }) => e.message).join('; ');
      res.status(400).json({ error: { code: ErrorCode.VALIDATION_ERROR, message: messages } });
      return;
    }
    const proposal = parse.data;

    try {
      mkdirSync(PROPOSALS_DIR, { recursive: true });
      const proposalPath = path.join(PROPOSALS_DIR, `${proposal.id}.json`);
      writeFileSync(proposalPath, JSON.stringify(proposal, null, 2), 'utf8');

      // 追加 ledger
      mkdirSync(path.dirname(LEDGER), { recursive: true });
      appendFileSync(LEDGER, JSON.stringify({
        type: 'proposal-stored',
        at: new Date().toISOString(),
        proposalId: proposal.id,
        kind: proposal.kind,
        targetPath: proposal.targetPath,
        ok: true,
      }) + '\n', 'utf8');

      res.json({ stored: true, id: proposal.id });
    } catch (e) {
      res.status(500).json({ error: { code: ErrorCode.INTERNAL_ERROR, message: e instanceof Error ? e.message : '存储提案失败' } });
    }
  }

  // GET /api/v1/rsi/proposals/:id - 读取提案制品
  getProposal(req: Request, res: Response): void {
    const id = req.params.id;
    if (!id || id.length > 128) {
      res.status(400).json({ error: { code: ErrorCode.VALIDATION_ERROR, message: '无效的 proposalId' } });
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
  }
}

// 导出内部函数供 rsi-apply.routes.ts 复用（避免循环依赖）
export async function storeProposalArtifact(proposalId: string, artifact: unknown): Promise<void> {
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  const proposalPath = path.join(PROPOSALS_DIR, `${proposalId}.json`);
  writeFileSync(proposalPath, JSON.stringify(artifact, null, 2), 'utf8');
}