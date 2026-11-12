/**
 * RsiController — 自我迭代的只读视图 + 两个动作端点。
 *
 * ── 为什么"动作端点"只记录、不动文件 ──────────────────────
 * 回滚是破坏性操作。让一个 HTTP 请求直接去 `git checkout` 或删除文件，
 * 意味着任何拿到本地端口的进程都能把仓库还原到任意代——这不是能力，是事故面。
 * 所以本控制器只做两件事：
 *   · `plan`：**判定**这次改动属于哪个域、要不要人批（纯计算，无副作用）；
 *   · `decide`：**记录**人的决定（追加一行决策日志，绝不改代码）。
 * 真正的回滚由脚本执行（`change-domain.rollbackTo`），带快照、带审计、可复核。
 *
 * 这条边界与「判据外置」是同一个道理：**判定与执行分离，谁都不能一条命令改天换地。**
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import { buildRsiRulesContract } from '../services/rsi/rules-contract.js';
import { buildRsiOverview } from '../services/rsi/rsi-overview.service.js';
import { CHANGE_DOMAINS, checkDomain, type IterationTrigger } from '../services/rsi/change-domain.js';
import { getIteration, listIterations, summarize } from '../services/rsi/iteration-store.js';
import type { Db } from '../repositories/db.js';

// 本文件在 src/controllers/ 下：'../..' 才是 server/（少一级会指向 src/）。
const SERVER = fileURLToPath(new URL('../..', import.meta.url));
const WORK = path.resolve(SERVER, '..', '.self-upgrade');
const DECISIONS = path.join(WORK, 'decisions.jsonl');

const TRIGGERS: readonly IterationTrigger[] = [
  'manual',
  'schedule',
  'failure-accumulation',
  'threshold-breach',
  'charter-drift',
];

/** 当前模型：进程环境优先，读不到再回落到 server/.env（循环按归因会轮换它）。 */
function currentModel(): string {
  if (process.env.RSI_MODEL) return process.env.RSI_MODEL;
  try {
    const m = /^RSI_MODEL=(.*)$/m.exec(readFileSync(path.join(SERVER, '.env'), 'utf8'));
    if (m?.[1]) return m[1].trim();
  } catch {
    /* 没有 .env 就如实说不知道 */
  }
  return 'unknown';
}

export class RsiController {
  constructor(private readonly db: Db) {}

  /** 契约：前后端共用的单一事实源（含 domains / decisions / iterationCriteria）。 */
  contract(_req: Request, res: Response): void {
    res.json(buildRsiRulesContract());
  }

  /**
   * 规则契约（/api/rsi/rules 的新家）。
   *
   * 与 `contract` 同源同体，唯一差别是这里显式禁缓存：契约虽静态，
   * 但它也嵌在 overview 的动态响应里，浏览器缓存旧 rules 会让两个出口
   * 在 HTTP 层分叉（普通 curl 断言抓不到）。
   */
  rules(_req: Request, res: Response): void {
    res.setHeader('Cache-Control', 'no-store');
    res.json(buildRsiRulesContract());
  }

  /**
   * 看板读数（/api/rsi/overview 的新家）。
   *
   * 装配逻辑在 `services/rsi/rsi-overview.service.ts`：控制器只做
   * 「取参 → 调服务 → 按服务给的 status 出响应」，不再碰 SQL。
   * 错误形状保持原样（字符串 error，不是 {code,message}），因为前端已按此解析。
   */
  overview(req: Request, res: Response): void {
    const sessionId = typeof req.query.session === 'string' ? req.query.session : null;
    if (!sessionId) {
      res.status(400).json({ error: '?session=xxx required' });
      return;
    }
    try {
      const out = buildRsiOverview(this.db, sessionId);
      if (!out.ok) {
        res.status(out.status).json({ error: out.error });
        return;
      }
      // 与 rules 一致禁用缓存：否则浏览器缓存旧 overview 会让两个出口分叉。
      res.setHeader('Cache-Control', 'no-store');
      res.json(out.payload);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? 'rsi overview failed' });
    }
  }

  /** 迭代列表 + 汇总。 */
  iterations(req: Request, res: Response): void {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
    const items = listIterations(limit);
    // 顺带下发域表与当前模型：前端不必自己抄一份「哪些域要人批」，抄了就会漂；
    // 模型由循环按归因轮换，轮询时面板要能显示「此刻跑的是哪一个」。
    res.json({
      items,
      summary: summarize(items),
      domains: CHANGE_DOMAINS.map((d) => ({ id: d.id, label: d.label, requiresHumanApproval: d.requiresHumanApproval })),
      model: currentModel(),
      serverTime: new Date().toISOString(),
    });
  }

  /** 单条迭代。 */
  iteration(req: Request, res: Response): void {
    const id = String(req.params.id ?? '');
    const found = getIteration(id);
    if (!found) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `没有这条迭代：${id}` } });
      return;
    }
    res.json(found);
  }

  /**
   * 域申请：给定拟改文件 + 触发方式 + 是否已批，回答「能不能改、要谁批、上限多少」。
   * 纯计算，不落盘——前端可以随便试，不会产生副作用。
   */
  plan(req: Request, res: Response): void {
    const body = (req.body ?? {}) as { files?: unknown; trigger?: unknown; humanApproved?: unknown };
    const files = Array.isArray(body.files) ? body.files.map((f) => String(f)) : [];
    const trigger = TRIGGERS.includes(body.trigger as IterationTrigger)
      ? (body.trigger as IterationTrigger)
      : 'manual';
    if (files.length === 0) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'files 不能为空' } });
      return;
    }
    res.json(checkDomain({ files, trigger, humanApproved: body.humanApproved === true }));
  }

  /**
   * 记录人的决定（approve / rollback / halt）。
   * **只写决策日志，不动任何代码**——回滚由脚本按快照执行，见文件头说明。
   */
  decide(req: Request, res: Response): void {
    const id = String(req.params.id ?? '');
    const body = (req.body ?? {}) as { action?: unknown; confirm?: unknown; note?: unknown };
    const action = String(body.action ?? '');
    if (!['approve', 'rollback', 'halt'].includes(action)) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'action 只能是 approve / rollback / halt' } });
      return;
    }
    // 破坏性动作必须显式确认：漏一个 confirm 就把代码还原了，是最难查的那类事故。
    if (action !== 'approve' && body.confirm !== true) {
      res.status(400).json({
        error: { code: 'CONFIRM_REQUIRED', message: `${action} 是破坏性动作，必须带 confirm: true` },
      });
      return;
    }
    const record = getIteration(id);
    if (!record) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `没有这条迭代：${id}` } });
      return;
    }

    const entry = {
      at: new Date().toISOString(),
      iterationId: id,
      task: record.task,
      action,
      note: typeof body.note === 'string' ? body.note.slice(0, 500) : '',
      // 记录当时的判定，便于事后核对「人是按什么信息拍的板」
      decision: record.result.decision,
      domain: record.domain,
      verdict: record.verdict,
    };
    mkdirSync(WORK, { recursive: true });
    appendFileSync(DECISIONS, `${JSON.stringify(entry)}\n`, 'utf8');

    res.json({
      ok: true,
      entry,
      // 明确告诉调用方：这只是记录，不是执行
      note:
        action === 'rollback'
          ? '已记录回滚决定。实际还原由脚本按快照执行（change-domain.rollbackTo），本接口不改动任何代码。'
          : '已记录决定。',
    });
  }

  /** 决策历史（供前端展示"谁在什么时候拍了什么板"）。 */
  decisions(_req: Request, res: Response): void {
    if (!existsSync(DECISIONS)) {
      res.json({ items: [] });
      return;
    }
    const items = readFileSync(DECISIONS, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((x): x is Record<string, unknown> => x !== null)
      .reverse()
      .slice(0, 100);
    res.json({ items });
  }
}
