/**
 * RSI Reflection Controller —— 反思报告与失败 Run 摘要（Minis 收集 Gap 来源）。
 *
 * 端点：
 *   GET /api/v1/rsi/reflection        -> 最近 N 条 RSI 反思报告（含 gaps[]）
 *   GET /api/v1/rsi/failed-runs       -> 最近 N 条失败 run 摘要（基于 judge_runs）
 *
 * 数据源：
 *   - reflection: ledger.jsonl 中 type: 'reflection' 条目
 *   - failed-runs: judge_repository (judge_runs 表)
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Db } from '../repositories/db.js';
import { JudgeRepository } from '../repositories/judge.repository.js';
import { AppError, ErrorCode } from '../utils/errors.js';

const SERVER = fileURLToPath(new URL('../..', import.meta.url));
const WORK = path.resolve(SERVER, '..', '.self-upgrade');
const LEDGER = path.join(WORK, 'ledger.jsonl');

const ReflectionQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(1),
});

type ReflectionQuery = z.infer<typeof ReflectionQuerySchema>;

export class RsiReflectionController {
  constructor(private readonly db: Db) {}

  // GET /api/v1/rsi/reflection - 最近 N 条 RSI 反思报告
  async getReflection(req: Request, res: Response): Promise<void> {
    const parse = ReflectionQuerySchema.safeParse(req.query);
    if (!parse.success) {
      res.status(400).json({ error: { code: ErrorCode.VALIDATION_ERROR, message: 'limit 必须是 1-100 的整数' } });
      return;
    }
    const { limit } = parse.data;

    if (!existsSync(LEDGER)) {
      res.json({ reflections: [], total: 0 });
      return;
    }

    try {
      const content = readFileSync(LEDGER, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      const reflections = lines
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((entry): entry is { type: string; gaps?: unknown[]; at: string; [key: string]: unknown } =>
          entry !== null && entry.type === 'reflection'
        )
        .slice(-limit)
        .reverse()
        .map(entry => ({
          at: entry.at,
          gaps: entry.gaps ?? [],
          priority: entry.priority ?? 'medium',
          evidence: entry.evidence ?? [],
          raw: entry,
        }));

      res.json({ reflections, total: reflections.length });
    } catch (e) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: e instanceof Error ? e.message : '读取反思报告失败' } });
    }
  }

  // GET /api/v1/rsi/failed-runs - 最近 N 条失败 run 摘要（基于 judge_runs）
  async getFailedRuns(req: Request, res: Response): Promise<void> {
    const parse = ReflectionQuerySchema.safeParse(req.query);
    if (!parse.success) {
      res.status(400).json({ error: { code: ErrorCode.VALIDATION_ERROR, message: 'limit 必须是 1-100 的整数' } });
      return;
    }
    const { limit } = parse.data;

    try {
      const judgeRepo = new JudgeRepository(this.db);

      // 获取最近的 judge_runs（按 id 降序）
      const runs = judgeRepo.listRuns({ limit: limit * 2 });

      // 过滤失败的 runs
      const failedRuns = runs
        .filter((run: { verdict: string }) => run.verdict === 'fail' || run.verdict === 'error')
        .slice(0, limit)
        .map((run: { id: number; verdict: string; score: number; coverage: number; executed: number; total: number; created_at: number }) => ({
          runId: String(run.id),
          task: '', // judge_runs 无 task 字段
          status: run.verdict,
          createdAt: run.created_at,
          error: null,
          stage: 'judge',
          verdicts: [{
            id: String(run.id),
            kind: run.verdict,
            lesson: '',
            reason: `Judge verdict: ${run.verdict}`,
            score: run.score,
          }],
        }));

      res.json({ failedRuns, total: failedRuns.length });
    } catch (e) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: e instanceof Error ? e.message : '获取失败 run 失败' } });
    }
  }
}