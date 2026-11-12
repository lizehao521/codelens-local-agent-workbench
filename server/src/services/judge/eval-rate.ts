/**
 * 判据 · task.test_pass_rate —— 「代码改动后真的能跑通吗」的机械读数。
 *
 * 与 tool.discipline.* 的区别：那几闸量的是「造工具的过程纪律」，
 * 这一闸量的是**产物本身**：在判决时刻重新执行固定套件，按 public+hidden
 * 全量计算通过率。Agent 的自述、eval.run 的回报都不采信 —— 只采信此刻的代码。
 *
 * 什么时候不产出判据（返回 null）：
 *   - 本轮没有成功调用过 eval.run。此时如果强行记 unexec，这条判据会进入
 *     每一层的分母，把所有无关会话的覆盖率拉下来 —— 一个从未参与代码修复的
 *     任务不该被这条判据判「未执行」。
 *
 * 什么时候记 unexec：调用过 eval.run，但套件总用例数为 0（配置为空）。
 * C4：没测到就是没测到，不能写成 pass。
 */

import { config } from '../../config/env.js';
import { runEvalBattery } from '../eval/runner.js';
import { EVAL_RUN_DISPLAY_NAME } from '../eval/suites.js';
import type { CriterionVerdict, JudgeEvidence } from './types.js';

export const TEST_PASS_RATE_CRITERION = 'task.test_pass_rate';

/**
 * 套件地板判据 —— 「修 A 有没有打坏 B」。
 *
 * 为什么需要它：上面那条判据量的是**整机聚合率** Σpassed/Σtotal。
 * 聚合率对单元崩塌不敏感，两个套件可以互相抵消：
 * 实测注入 parse_query 2/8→8/8（+6）同时 csv_import 7/17→2/17（-5），
 * 整机率 0.691→0.699，内核判 improved 并写「全部指标严格变好」。
 * 这不是理论风险：g4 那一代把 csv_import 从 7/17 改到 1/17 只让整机掉 0.044，
 * 恰好没有另一套件上涨来抵消，才被抓到。
 *
 * 口径边界（写清以免被当成万能）：
 *   - 只比较**两边都存在且总用例数相同**的套件；总用例数变了说明题面变了，
 *     与历史不可比，排除出分母并单列说明，不当成回退。
 *   - 上一代有、这一代整条消失的套件算回退（题被删掉比题没做对更严重）。
 *   - 判据只要求「不下降」，通过率上升不额外加分（那是 objective 的职责）。
 */
export const SUITE_FLOOR_CRITERION = 'task.suite_floor';

export interface SuiteScore {
  id: string;
  passed: number;
  total: number;
}

/** 从 task.test_pass_rate 的 verdict.data.suites 取出套件级读数；取不到返回 null。 */
export function readSuiteScores(verdicts: CriterionVerdict[]): SuiteScore[] | null {
  const v = verdicts.find((x) => x.criterion === TEST_PASS_RATE_CRITERION);
  const suites = (v?.data as { suites?: unknown } | undefined)?.suites;
  if (!Array.isArray(suites) || suites.length === 0) return null;
  const out: SuiteScore[] = [];
  for (const s of suites) {
    const row = s as Partial<SuiteScore>;
    if (typeof row?.id !== 'string') continue;
    if (typeof row.passed !== 'number' || typeof row.total !== 'number') continue;
    out.push({ id: row.id, passed: row.passed, total: row.total });
  }
  return out.length ? out : null;
}

export interface SuiteFloorResult {
  score: number;
  kept: number;
  comparable: number;
  /** 通过率下降的套件（`id 旧 → 新`）。 */
  regressions: string[];
  /** 题面变化（总用例数不同）被排除出比较的套件。 */
  incomparable: string[];
}

/** 逐套件比较两代读数，返回「不回退套件占比」。无可比套件时返回 null。 */
export function suiteFloor(prev: SuiteScore[], cur: SuiteScore[]): SuiteFloorResult | null {
  const prevMap = new Map(prev.map((s) => [s.id, s]));
  const curMap = new Map(cur.map((s) => [s.id, s]));
  const regressions: string[] = [];
  const incomparable: string[] = [];
  let kept = 0;
  let comparable = 0;

  for (const p of prev) {
    const c = curMap.get(p.id);
    if (!c) {
      // 整条套件消失：按回退处理（分母也算它，因为上一代确实有这道题）。
      comparable += 1;
      regressions.push(`${p.id} ${p.passed}/${p.total} → 套件缺失`);
      continue;
    }
    if (c.total !== p.total) {
      incomparable.push(`${p.id} 题数 ${p.total}→${c.total}`);
      continue;
    }
    comparable += 1;
    if (c.passed >= p.passed) kept += 1;
    else regressions.push(`${p.id} ${p.passed}/${p.total} → ${c.passed}/${c.total}`);
  }

  // 这一代新增的套件不参与（上一代没有基线，谈不上退步），但要标出来，
  // 否则读者会以为「13 个套件全在分母里」而实际只比了 12 个。
  for (const c of cur) {
    if (!prevMap.has(c.id)) incomparable.push(`${c.id} 本代新增`);
  }

  if (comparable === 0) return null;
  return {
    score: Math.round((kept / comparable) * 1000) / 1000,
    kept,
    comparable,
    regressions,
    incomparable,
  };
}

/** 把套件地板结果包成判据判决；无可比基线时返回 null（不产出，绝不造假读数）。 */
export function suiteFloorVerdict(
  prev: SuiteScore[] | null,
  cur: SuiteScore[] | null,
): CriterionVerdict | null {
  if (!prev || !cur) return null;
  const r = suiteFloor(prev, cur);
  if (!r) return null;
  const tail = [
    r.regressions.length ? `回退：${r.regressions.join('、')}` : '',
    r.incomparable.length ? `不可比：${r.incomparable.join('、')}` : '',
  ].filter(Boolean).join('；');
  return {
    layer: 'L1',
    criterion: SUITE_FLOOR_CRITERION,
    status: r.score >= 1 ? 'pass' : 'fail',
    score: r.score,
    detail: `套件地板 ${r.kept}/${r.comparable} 未回退${tail ? `（${tail}）` : ''}`,
    data: {
      kept: r.kept,
      comparable: r.comparable,
      regressions: r.regressions,
      incomparable: r.incomparable,
    },
  };
}

export function evalPassRateGate(evidence: JudgeEvidence): CriterionVerdict | null {
  const ranEval = evidence.toolCalls.some(
    (call) => call.display_name === EVAL_RUN_DISPLAY_NAME && call.status === 'success',
  );
  if (!ranEval) return null;

  const battery = runEvalBattery(config.sandboxRoot, { includeHidden: true });
  if (battery.total === 0) {
    return {
      layer: 'L1',
      criterion: TEST_PASS_RATE_CRITERION,
      status: 'unexec',
      detail: '固定评测套件没有可执行用例，通过率不可测，按 C4 记 unexec',
      data: {
        passed: 0,
        total: 0,
        denominator: 0,
        score: 0,
        suites: [],
        // 元数据契约与正常分支完全一致：旧会话/空配置也不会出现字段缺失导致的分层。
        evalSetFingerprint: battery.evalSetFingerprint,
        failureKinds: battery.failureKinds,
        samples: 1,
        reliability: 'unmeasured',
      },
    };
  }

  const failing = battery.suites
    .filter((s) => !s.ok)
    .map((s) => `${s.id} ${s.passed}/${s.total}${s.error ? `（${s.error}）` : ''}`);

  return {
    layer: 'L1',
    criterion: TEST_PASS_RATE_CRITERION,
    status: battery.score >= 1 ? 'pass' : 'fail',
    score: battery.score,
    detail:
      `固定评测套件 ${battery.passed}/${battery.total} 通过（含隐藏用例）` +
      (failing.length ? `；未满分：${failing.join('、')}` : ''),
    // 结构化读数：分母与套件清单必须能被机器直接消费，不能靠解析上面的文案。
    data: {
      passed: battery.passed,
      total: battery.total,
      denominator: battery.total,
      score: battery.score,
      suites: battery.suites.map((s) => ({
        id: s.id,
        title: s.title,
        ok: s.ok,
        passed: s.passed,
        total: s.total,
        publicPassed: s.publicPassed,
        publicTotal: s.publicTotal,
        ...(s.error ? { error: s.error } : {}),
      })),
      // 评测运行元数据（纯展示/诊断，不参与计分、不进 RsiManifest 与 anchor 原像）：
      // - 指纹用于机器判定「测量对象变了没有」，变了就不能跨代比较；
      // - 失败分类是机械统计，归因器不必靠模型自述猜原因；
      // - samples=1 时 pass^k 不可计算，如实标 unmeasured，不冒充可靠性结论。
      evalSetFingerprint: battery.evalSetFingerprint,
      failureKinds: battery.failureKinds,
      samples: 1,
      reliability: 'unmeasured',
    },
  };
}
