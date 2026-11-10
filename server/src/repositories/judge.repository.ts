/**
 * Judge repository — 判决 r 与证据 τ 的持久化分离（强化内核宣言第 1 节）。
 *
 * 三张表各司其职：
 *  - judge_runs        一次判决的汇总（verdict / score / coverage）
 *  - judge_verdicts    每条判据的单次结论（含 unexec），可跨会话按判据聚合
 *  - policy_injections 某次 Act 注入了哪些 π 经验，用于事后算「经验是否真的有效」
 *
 * 审计数据刻意不级联删除：会话删了，当时的判决仍应可复盘。
 */

import type { Db } from './db.js';
import type { CriterionVerdict, JudgeLayer, RunVerdict, VerdictStatus } from '../services/judge/types.js';

export interface JudgeRunRow {
  id: number;
  session_id: string;
  verdict: RunVerdict;
  score: number;
  coverage: number;
  executed: number;
  total: number;
  context_json: string | null;
  created_at: number;
  /**
   * 该行是「L2 LLM 深判」时指向被深判的原判决；规则判决恒为 null。
   * 迁移前写入的旧行在补列后读出来同样是 null（SQLite ADD COLUMN 默认值）。
   */
  parent_run: number | null;
}

export interface JudgeVerdictRow {
  id: number;
  run_id: number;
  session_id: string;
  layer: JudgeLayer;
  criterion: string;
  status: VerdictStatus;
  score: number | null;
  detail: string | null;
  created_at: number;
}

export interface CriterionStat {
  criterion: string;
  layer: JudgeLayer;
  pass: number;
  fail: number;
  unexec: number;
  total: number;
}

/** 单档（规则 / 深判）的判决计数。unit = 行：一次深判 = 一行 = 一个样本。 */
export interface TierBucket {
  runs: number;
  pass: number;
  fail: number;
  inconclusive: number;
}

export interface LessonEffectiveness {
  lesson: string;
  injected: number;
  passes: number;
  fails: number;
  inconclusive: number;
  pending: number;
  /** 已知结果里通过的比例；无已知结果时为 null（不编造 0）。 */
  passRate: number | null;
  /**
   * 全库深判（parent_run IS NOT NULL）的结论分布。
   *
   * 刻意是**进程级**而非按经验切分：深判是抽样行为，按经验切分后大多数行
   * 都会落在 0 样本上，那个 0 会被误读成「该经验无效」。这里只提供
   * 「深判抽样到目前为止判了什么」这个观察面，不参与 passRate。
   */
  deepVerdicts: { passes: number; fails: number; inconclusive: number };
}

export interface InsertRunInput {
  sessionId: string;
  verdict: RunVerdict;
  score: number;
  coverage: number;
  executed: number;
  total: number;
  /** 结构化上下文；会被 JSON.stringify 后入库。 */
  context?: unknown;
  /**
   * 已编码好的 context_json（判据塔 v2 用 gzip 快照）。优先于 `context`：
   * 编码必须在 service 侧完成，仓储不该知道压缩格式。
   */
  contextJson?: string;
  /**
   * L2 LLM 深判的父判决 id。缺省（undefined/null）= 规则判决，插 null。
   * 刻意与 `context` 同级而非嵌进 context：它是关系而非证据。
   */
  parentRun?: number | null;
}

export class JudgeRepository {
  constructor(private readonly db: Db) {}

  insertRun(input: InsertRunInput): number {
    const contextJson =
      input.contextJson ?? (input.context === undefined ? null : JSON.stringify(input.context));
    const result = this.db.run(
      `INSERT INTO judge_runs
         (session_id, verdict, score, coverage, executed, total, context_json, created_at, parent_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.sessionId,
        input.verdict,
        input.score,
        input.coverage,
        input.executed,
        input.total,
        contextJson,
        Date.now(),
        input.parentRun ?? null,
      ],
    );
    return Number(result.lastInsertRowid);
  }

  insertVerdicts(runId: number, sessionId: string, verdicts: CriterionVerdict[]): void {
    const now = Date.now();
    for (const v of verdicts) {
      this.db.run(
        `INSERT INTO judge_verdicts (run_id, session_id, layer, criterion, status, score, detail, data_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          runId,
          sessionId,
          v.layer,
          v.criterion,
          v.status,
          v.score ?? null,
          v.detail ?? null,
          v.data ? JSON.stringify(v.data) : null,
          now,
        ],
      );
    }
  }

  listRuns(options: { sessionId?: string; limit?: number } = {}): JudgeRunRow[] {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
    if (options.sessionId) {
      return this.db.all<JudgeRunRow>(
        `SELECT * FROM judge_runs WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
        [options.sessionId, limit],
      );
    }
    return this.db.all<JudgeRunRow>(`SELECT * FROM judge_runs ORDER BY id DESC LIMIT ?`, [limit]);
  }

  getRun(id: number): JudgeRunRow | undefined {
    return this.db.get<JudgeRunRow>(`SELECT * FROM judge_runs WHERE id = ?`, [id]);
  }

  /**
   * 某条规则判决下的全部深判子行（新的在前）。
   * 幂等判定与「最新深判摘要」都从这里读，避免两处口径分叉。
   */
  listDeepRuns(parentRunId: number): JudgeRunRow[] {
    return this.db.all<JudgeRunRow>(
      `SELECT * FROM judge_runs WHERE parent_run = ? ORDER BY id DESC`,
      [parentRunId],
    );
  }

  /** 该 run 最新一条深判子行；没深判过则为 undefined。 */
  latestDeepRun(parentRunId: number): JudgeRunRow | undefined {
    return this.db.get<JudgeRunRow>(
      `SELECT * FROM judge_runs WHERE parent_run = ? ORDER BY id DESC LIMIT 1`,
      [parentRunId],
    );
  }

  listVerdicts(runId: number): JudgeVerdictRow[] {
    return this.db.all<JudgeVerdictRow>(
      `SELECT * FROM judge_verdicts WHERE run_id = ? ORDER BY id ASC`,
      [runId],
    );
  }

  /** 按判据聚合全部历史判决：这是「判据塔自证」的数据面。 */
  criterionStats(): CriterionStat[] {
    return this.db.all<CriterionStat>(
      `SELECT criterion,
              MAX(layer) AS layer,
              SUM(CASE WHEN status = 'pass'   THEN 1 ELSE 0 END) AS pass,
              SUM(CASE WHEN status = 'fail'   THEN 1 ELSE 0 END) AS fail,
              SUM(CASE WHEN status = 'unexec' THEN 1 ELSE 0 END) AS unexec,
              COUNT(*) AS total
       FROM judge_verdicts
       GROUP BY criterion
       ORDER BY criterion ASC`,
    );
  }

  /** 记录一次 Act 的注入结果（同一会话同一经验只记一次，避免重复放大统计）。 */
  recordInjections(sessionId: string, policyVersion: number, lessons: string[]): number {
    if (lessons.length === 0) return 0;
    const existing = new Set(
      this.db
        .all<{ lesson: string }>(`SELECT lesson FROM policy_injections WHERE session_id = ?`, [sessionId])
        .map((r) => r.lesson),
    );
    let inserted = 0;
    const now = Date.now();
    for (const lesson of lessons) {
      if (existing.has(lesson)) continue;
      this.db.run(
        `INSERT INTO policy_injections (session_id, policy_version, lesson, created_at)
         VALUES (?, ?, ?, ?)`,
        [sessionId, policyVersion, lesson, now],
      );
      inserted += 1;
    }
    return inserted;
  }

  /**
   * 每条经验的实际效果：把「注入过该经验的会话」与「该会话最终判决」关联。
   * 一个会话可能有多次判决，只取最后一次作为该会话的结论。
   * 没有任何判决结果的会话记为 pending —— 不参与 passRate，也不假装通过。
   *
   * 「最后一次」只数规则判决（parent_run IS NULL）：深判是事后抽样产生的新行，
   * 它 id 更大但不是该会话的「最终规则结论」。不排除它，任何被深判过的会话都会
   * 用深判结论替换原结论，passRate 会系统性偏严（深判 fail 率天然更高）。
   */
  lessonEffectiveness(): LessonEffectiveness[] {
    const rows = this.db.all<{
      lesson: string;
      injected: number;
      passes: number;
      fails: number;
      inconclusive: number;
      pending: number;
    }>(
      `SELECT t.lesson AS lesson,
              COUNT(*) AS injected,
              SUM(CASE WHEN lr.verdict = 'pass'         THEN 1 ELSE 0 END) AS passes,
              SUM(CASE WHEN lr.verdict = 'fail'         THEN 1 ELSE 0 END) AS fails,
              SUM(CASE WHEN lr.verdict = 'inconclusive' THEN 1 ELSE 0 END) AS inconclusive,
              SUM(CASE WHEN lr.verdict IS NULL          THEN 1 ELSE 0 END) AS pending
       FROM (SELECT DISTINCT session_id, lesson FROM policy_injections) t
       LEFT JOIN (
         SELECT jr.session_id, jr.verdict
         FROM judge_runs jr
         JOIN (
           SELECT session_id, MAX(id) AS mid
           FROM judge_runs
           WHERE parent_run IS NULL
           GROUP BY session_id
         ) m ON m.mid = jr.id
       ) lr ON lr.session_id = t.session_id
       GROUP BY t.lesson
       ORDER BY injected DESC, t.lesson ASC`,
    );
    const deep = this.db.get<{ passes: number; fails: number; inconclusive: number }>(
      `SELECT SUM(CASE WHEN verdict = 'pass'         THEN 1 ELSE 0 END) AS passes,
              SUM(CASE WHEN verdict = 'fail'         THEN 1 ELSE 0 END) AS fails,
              SUM(CASE WHEN verdict = 'inconclusive' THEN 1 ELSE 0 END) AS inconclusive
       FROM judge_runs
       WHERE parent_run IS NOT NULL`,
    );
    // SUM 在空集上返回 NULL，不是 0 —— 用 ?? 兜住，避免 passRate 旁边出现 "null 样本"。
    const deepVerdicts = {
      passes: deep?.passes ?? 0,
      fails: deep?.fails ?? 0,
      inconclusive: deep?.inconclusive ?? 0,
    };
    return rows.map((r) => {
      const known = r.passes + r.fails;
      return {
        ...r,
        passRate: known === 0 ? null : Math.round((r.passes / known) * 1000) / 1000,
        deepVerdicts,
      };
    });
  }

  countRuns(): number {
    const row = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM judge_runs`);
    return row?.n ?? 0;
  }

  // ── 洞察视图用的只读聚合（全部有界，只允许 all/get）──────────────────────────

  /**
   * 最近 `limit` 条判决按档（规则 / 深判）的分布。
   *
   * 刻意只取一个窗口（`ORDER BY id DESC LIMIT ?`）在内存分组，而不是对全表做两次
   * `GROUP BY`：这个视图是用来回答「最近这段时间它工作得怎么样」，不是全库普查；
   * 全表聚合会随着判决累积越来越慢，而它每打开一次面板就要跑一次。
   *
   * 档位判定与 `listRuns`/`getRun` 完全同一表达式（`parent_run IS NULL`），
   * 不引入第二种判法。
   */
  tierDistribution(limit: number): {
    rules: TierBucket & { lastRunId: number | null; lastCreatedAt: number | null };
    deep: TierBucket & {
      lastRunId: number | null;
      lastCreatedAt: number | null;
      coveredOriginals: number;
      repeatParents: number;
    };
  } {
    const rows = this.db.all<{ id: number; parent_run: number | null; verdict: string; created_at: number }>(
      `SELECT id, parent_run, verdict, created_at FROM judge_runs ORDER BY id DESC LIMIT ?`,
      [limit],
    );

    const empty = (): TierBucket & { lastRunId: number | null; lastCreatedAt: number | null } => ({
      runs: 0,
      pass: 0,
      fail: 0,
      inconclusive: 0,
      lastRunId: null,
      lastCreatedAt: null,
    });
    const rules = empty();
    const deep = { ...empty(), coveredOriginals: 0, repeatParents: 0 };

    const parentCounts = new Map<number, number>();

    // rows 已按 id DESC 排序，所以每个桶第一次遇到的 id 就是「最近一条」。
    for (const row of rows) {
      const isDeep = row.parent_run !== null && row.parent_run !== undefined;
      const bucket = isDeep ? deep : rules;
      bucket.runs += 1;
      if (row.verdict === 'pass') bucket.pass += 1;
      else if (row.verdict === 'fail') bucket.fail += 1;
      else bucket.inconclusive += 1;
      if (bucket.lastRunId === null) {
        bucket.lastRunId = row.id;
        bucket.lastCreatedAt = row.created_at;
      }
      if (isDeep) {
        const parent = row.parent_run as number;
        parentCounts.set(parent, (parentCounts.get(parent) ?? 0) + 1);
      }
    }

    deep.coveredOriginals = parentCounts.size;
    for (const count of parentCounts.values()) {
      if (count >= 2) deep.repeatParents += 1;
    }

    return { rules, deep };
  }

  /**
   * 最近 `limit` 条深判行（只取 id 与快照）。
   *
   * 上界必须由调用方传常量：深判的花费只存在 `context_json.deep.usage` 里，
   * SQL 无法从 `gz:` 文本中取字段，只能在 Node 侧解压。给它一个 query 参数当入口
   * 等于允许前端随手触发慢查询。
   */
  recentDeepRuns(limit: number): Array<{ id: number; context_json: string }> {
    return this.db.all<{ id: number; context_json: string }>(
      `SELECT id, context_json FROM judge_runs
        WHERE parent_run IS NOT NULL
        ORDER BY id DESC
        LIMIT ?`,
      [limit],
    );
  }

  /** 最近一条规则判决（用于取「最近一次判决里各层的覆盖率」）。 */
  latestRulesRun(): { id: number; context_json: string } | undefined {
    return this.db.get<{ id: number; context_json: string }>(
      `SELECT id, context_json FROM judge_runs
        WHERE parent_run IS NULL
        ORDER BY id DESC
        LIMIT 1`,
    );
  }
}
