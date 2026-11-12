/**
 * rsi-overview.service.ts — RSI 看板的读数装配。
 *
 * ── 为什么从 app.ts 搬出来 ────────────────────────────────
 * 这段逻辑原来内联在 `app.ts`（入口装配文件）里，约 55 行：查会话、查每代判决、
 * 查代际对比、查归因经验，再拼成一个大对象。后果有三：
 *   1. 入口文件同时承担「装配」和「业务」，与项目自己的分层铁律冲突；
 *   2. 同一份读数只能从 `/api/rsi/overview` 一个出口拿，想迁到 `/api/v1` 就得复制粘贴；
 *   3. 纯 SQL 拼装不可单测（要先起 express）。
 *
 * 搬到服务层后，入口只留一行转发，`/api/v1/rsi/overview` 与 `/api/rsi/overview`
 * 共用同一个函数——两个出口的响应体因此**在结构上不可能分叉**，
 * 而不是靠「两边都记得改」来维持一致。
 *
 * ── 返回值为什么是判别联合，不是直接 res.json ──────────────
 * 服务层不 import req/res（分层铁律），所以这里只回答「拿到了」或「为什么没拿到」，
 * 由 controller 决定 HTTP 码。错误文案与状态码逐字保留原实现的，避免前端解析规则变化。
 */

import type { Db } from '../../repositories/db.js';
import { buildRsiRulesContract } from './rules-contract.js';

export type RsiOverviewOutcome =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; status: 400 | 404; error: string };

/** 解析 judge_verdicts.data_json；旧行是 NULL、脏 JSON 也一律当成「没有」。 */
export function parseJsonColumn(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const EVAL_CRITERION = 'task.test_pass_rate';

/**
 * 把 task.test_pass_rate 的判决行整理成看板可直接消费的形状。
 *
 * 兼容策略：优先用带结构化 data 的**最新**判决；如果该会话还没有任何结构化行
 * （007 迁移之前的旧数据），退回最新一行并标 `source: 'detail_only'`，
 * 此时数值字段为 null、suites 为空 —— 前端据此走旧路径，不会拿到假数字。
 */
export function buildEvalSummary(
  verdicts: any[],
  judgeRuns: Array<{ id: number; created_at: number }>,
): Record<string, unknown> | null {
  let latest: any = null;
  let latestStructured: any = null;
  for (const v of verdicts) {
    if (v.criterion !== EVAL_CRITERION) continue;
    latest = v;
    if (v.data) latestStructured = v;
  }
  const chosen = latestStructured ?? latest;
  if (!chosen) return null;

  const data = (chosen.data ?? null) as Record<string, any> | null;
  const num = (key: string): number | null =>
    typeof data?.[key] === 'number' ? (data[key] as number) : null;
  const total = num('total');
  const run = judgeRuns.find((r) => r.id === chosen.run_id);

  return {
    runId: chosen.run_id,
    status: chosen.status,
    score: chosen.score ?? null,
    detail: chosen.detail ?? null,
    measuredAt: run?.created_at ?? null,
    passed: num('passed'),
    total,
    denominator: num('denominator') ?? total,
    suites: Array.isArray(data?.suites) ? data!.suites : [],
    source: data ? 'structured' : 'detail_only',
    // 评测运行元数据：旧行没有这些字段时给中性缺省值，前端据此显示「未标注」，
    // 绝不把缺失伪装成 0 或已测量（与 detail_only 的兼容策略同一口径）。
    evalSetFingerprint:
      typeof data?.evalSetFingerprint === 'string' ? data.evalSetFingerprint : null,
    failureKinds:
      data?.failureKinds && typeof data.failureKinds === 'object' && !Array.isArray(data.failureKinds)
        ? (data.failureKinds as Record<string, number>)
        : {},
    samples: num('samples') ?? 1,
    reliability: typeof data?.reliability === 'string' ? data.reliability : 'unmeasured',
  };
}

/**
 * 装配某个会话的 RSI 读数。
 *
 * 响应字段与原 `app.ts` 内联实现逐字一致（session / judgeRuns / verdictsByRun /
 * rsiRuns / attributions / eval / rules）——**迁地址不改契约**，
 * 前端 `getRsiOverview` 的解析规则一个字都不用动。
 */
export function buildRsiOverview(db: Db, sessionId: string): RsiOverviewOutcome {
  const session = db.get(
    `SELECT id, title, provider, model, created_at FROM sessions WHERE id = ?`,
    [sessionId],
  );
  if (!session) return { ok: false, status: 404, error: 'session not found' };

  // 每代 judge_run 汇总 + 其 verdicts
  const judgeRuns = db.all(
    `SELECT id, verdict, score, coverage, executed, total, created_at
       FROM judge_runs WHERE session_id = ? ORDER BY id ASC`,
    [sessionId],
  );
  const verdictsByRun = new Map<number, any[]>();
  const allVerdicts = db.all<any>(
    `SELECT run_id, layer, criterion, status, score, detail, data_json
       FROM judge_verdicts WHERE session_id = ? ORDER BY run_id, id ASC`,
    [sessionId],
  );
  for (const v of allVerdicts) {
    // data_json 是 007 迁移新增的列；旧行为 NULL，这里统一解成 data 字段，
    // 解不出来就当没有（绝不能让一条脏 JSON 把整个看板打成 500）。
    v.data = parseJsonColumn(v.data_json);
    delete v.data_json;
    if (!verdictsByRun.has(v.run_id)) verdictsByRun.set(v.run_id, []);
    verdictsByRun.get(v.run_id)!.push(v);
  }

  // 每代 RSI 对比（prev → next）
  const rsiRuns = db.all(
    `SELECT generation, prev_generation, verdict, exit_code,
            reasons_json, prev_readings_json, next_readings_json
       FROM policy_rsi_runs WHERE session_id = ? ORDER BY generation ASC`,
    [sessionId],
  );

  // 归因经验（policy_injections）—— 每条 π' 的增量
  const attributions = db.all(
    `SELECT id, policy_version, lesson, created_at
       FROM policy_injections WHERE session_id = ?
       ORDER BY id DESC LIMIT 20`,
    [sessionId],
  );

  // Map 不能直接交给 res.json：JSON.stringify(new Map()) 是 {}，
  // 前端会拿到空对象，趋势图和指标条永远是空的。这里显式转成普通对象。
  const verdictsByRunJson: Record<string, any[]> = Object.fromEntries(verdictsByRun);

  return {
    ok: true,
    payload: {
      session,
      judgeRuns,
      verdictsByRun: verdictsByRunJson,
      rsiRuns,
      attributions,
      eval: buildEvalSummary(allVerdicts, judgeRuns as Array<{ id: number; created_at: number }>),
      rules: buildRsiRulesContract(),
    },
  };
}
