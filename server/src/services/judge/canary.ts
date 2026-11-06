/**
 * L1 金丝雀：判据自己的判据（强化内核宣言 C3「自证」）。
 *
 * 一条判据如果永远返回 pass，它不是判据，是装饰。所以这里内置一组
 * 「已知好 / 已知坏」的合成轨迹，要求 L0 判据必须把它们分开：
 *
 *   - 已知好的被判红  ⇒ 判据过严（假红，会误杀正常任务）
 *   - 已知坏的被判绿  ⇒ 判据永真（假绿，正是宣言反复警告的那类欺骗）
 *
 * 金丝雀不通过时，JudgeService 会把本轮 L0 结果整体降级为 unexec ——
 * 判据不可信时，它给出的任何结论都不该被采信。这是「判据自己要先被判据检验」。
 */

import { L0_CRITERIA, DEFAULT_L0_THRESHOLDS, type L0Criterion, type L0Thresholds } from './criteria.js';
import { statusToScore, type CriterionVerdict, type JudgeEvidence, type VerdictStatus } from './types.js';
import type { SemanticAssessor, SemanticEvidence } from './semantic.js';

export interface CanaryCase {
  name: string;
  expected: 'good' | 'bad';
  evidence: JudgeEvidence;
}

/** 已知好的轨迹：所有判据都得有明确结论（不允许 unexec，否则样本本身没覆盖到）。 */
const GOOD: CanaryCase = {
  name: 'good.steady',
  expected: 'good',
  evidence: {
    sessionId: 'canary-good',
    finishReason: 'stop',
    iteration: 4,
    tokenBudget: 200_000,
    usage: { promptTokens: 40_000, completionTokens: 12_000 },
    toolCalls: [
      { status: 'success', display_name: '读取文件' },
      { status: 'success', display_name: '写入文件' },
      { status: 'success', display_name: '计算结果' },
    ],
    approvals: [{ status: 'decided', decision: 'allow_once' }],
    circuitOpened: false,
  },
};

/** 已知坏样本 1：工具全线失败 + 迭代耗尽。 */
const BAD_TOOLING: CanaryCase = {
  name: 'bad.tooling',
  expected: 'bad',
  evidence: {
    sessionId: 'canary-bad-tooling',
    finishReason: 'max_iterations',
    iteration: 12,
    tokenBudget: 200_000,
    usage: { promptTokens: 150_000, completionTokens: 40_000 },
    toolCalls: [
      { status: 'failed', display_name: '读取文件', error_kind: 'PATH_OUTSIDE_SANDBOX' },
      { status: 'failed', display_name: '写入文件', error_kind: 'PATH_OUTSIDE_SANDBOX' },
      { status: 'failed', display_name: 'HTTP 请求', error_kind: 'HTTP_DENIED' },
    ],
    approvals: [],
    circuitOpened: false,
  },
};

/** 已知坏样本 2：熔断后中止。 */
const BAD_CIRCUIT: CanaryCase = {
  name: 'bad.circuit',
  expected: 'bad',
  evidence: {
    sessionId: 'canary-bad-circuit',
    finishReason: 'aborted',
    iteration: 9,
    tokenBudget: 200_000,
    usage: { promptTokens: 90_000, completionTokens: 20_000 },
    toolCalls: [
      { status: 'success', display_name: '读取文件' },
      { status: 'timeout', display_name: 'HTTP 请求' },
      { status: 'failed', display_name: 'HTTP 请求', error_kind: 'TIMEOUT' },
    ],
    approvals: [],
    circuitOpened: true,
  },
};

/** 已知坏样本 3：审批全被拒 + 预算耗尽，却「正常结束」—— 最容易骗过单一指标的形态。 */
const BAD_FRICTION: CanaryCase = {
  name: 'bad.friction',
  expected: 'bad',
  evidence: {
    sessionId: 'canary-bad-friction',
    finishReason: 'budget_exhausted',
    iteration: 7,
    tokenBudget: 100_000,
    usage: { promptTokens: 95_000, completionTokens: 20_000 },
    toolCalls: [{ status: 'success', display_name: '读取文件' }],
    approvals: [
      { status: 'decided', decision: 'reject' },
      { status: 'decided', decision: 'reject' },
      { status: 'decided', decision: 'allow_once' },
    ],
    circuitOpened: false,
  },
};

export const CANARY_CASES: CanaryCase[] = [GOOD, BAD_TOOLING, BAD_CIRCUIT, BAD_FRICTION];

// ── L2 语义金丝雀 ────────────────────────────────────────────────────────
// L1 必须能覆盖 L2，否则「语义判据接入」只是换了个地方失去自证：
// 一个恒 pass 的 assessor 会让每次任务都在 L2 拿绿灯，而没有任何东西会发现它。
// 这三条合成语义样本要求 assessor 必须把「做完了 / 只说不做 / 没回答」分开。

export interface SemanticCanaryCase {
  name: string;
  /** 已知坏样本的期望只能是 fail：语义层没有「部分完成」这一档可供蒙混。 */
  expected: 'pass' | 'fail';
  evidence: SemanticEvidence;
}

function semanticCase(
  name: string,
  expected: 'pass' | 'fail',
  goal: string,
  finalAnswer: string,
  assistantTurns: number,
  toolSummary: { total: number; success: number; failed: number },
  finishReason = 'stop',
): SemanticCanaryCase {
  return {
    name,
    expected,
    evidence: {
      goal,
      finalAnswer,
      assistantTurns,
      toolSummary,
      finishReason,
      charCount: { goal: goal.length, finalAnswer: finalAnswer.length },
      goalTruncated: false,
      answerTruncated: false,
      truncated: false,
    },
  };
}

export const SEMANTIC_CANARY_CASES: SemanticCanaryCase[] = [
  semanticCase(
    'semantic.good',
    'pass',
    '统计 server/src 下所有 TypeScript 文件的总行数并给出表格',
    '已统计完成：server/src 下共 42 个 TypeScript 文件，合计 12034 行，表格如下（按目录分组）。',
    3,
    { total: 2, success: 2, failed: 0 },
  ),
  semanticCase(
    'semantic.plan_only',
    'fail',
    '修复登录接口的 500 错误',
    '接下来我将先读取 auth.controller.ts，然后定位异常并修复。',
    1,
    { total: 0, success: 0, failed: 0 },
  ),
  semanticCase(
    'semantic.empty_answer',
    'fail',
    '把 config 目录下的 yaml 合并成一个文件',
    '',
    1,
    { total: 0, success: 0, failed: 0 },
  ),
];

export interface SemanticCanaryResult {
  assessorId: string;
  cases: Array<{ name: string; expected: 'pass' | 'fail'; actual: VerdictStatus; ok: boolean }>;
  ok: boolean;
  detail: string;
}

/** L2 自证：assessor 必须把三条合成样本判对；replaceable 为「恒 pass」时必然打红。 */
function runSemanticCanary(assessor: SemanticAssessor): SemanticCanaryResult {
  const cases = SEMANTIC_CANARY_CASES.map((c) => {
    const actual = assessor.assess(c.evidence).status;
    return { name: c.name, expected: c.expected, actual, ok: actual === c.expected };
  });
  const wrong = cases.filter((c) => !c.ok);
  return {
    assessorId: assessor.id,
    cases,
    ok: wrong.length === 0,
    detail:
      wrong.length === 0
        ? `语义判据判别力成立（assessor=${assessor.id}）`
        : `语义判据判别力不成立：${wrong
            .map((c) => `${c.name} 期望 ${c.expected} 实际 ${c.actual}`)
            .join('；')}`,
  };
}

/** 判别力门槛：好的必须够绿、坏的必须够红、差距必须够大。 */
export const CANARY_THRESHOLDS = {
  minGoodScore: 0.8,
  maxBadScore: 0.4,
  minGap: 0.3,
} as const;

export interface CanaryOutcome {
  verdict: CriterionVerdict;
  goodScore: number;
  badScore: number;
  cases: Array<{ name: string; expected: 'good' | 'bad'; score: number | null; unexec: string[] }>;
  /** 语义层的自证结果；未注入 assessor 时为 null（= L2 不可用，不是通过）。 */
  semantic: SemanticCanaryResult | null;
}

/** 对单个样本跑全部 L0 判据，返回平均分（unexec 不计）与未执行项。 */
function scoreCase(c: CanaryCase, thresholds: L0Thresholds, criteria: L0Criterion[]) {
  const verdicts = criteria.map((fn) => fn(c.evidence, thresholds));
  const scored = verdicts.map((v) => statusToScore(v.status)).filter((s): s is number => s !== null);
  const unexec = verdicts.filter((v) => v.status === 'unexec').map((v) => v.criterion);
  const score = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null;
  return { verdicts, score: score === null ? null : Math.round(score * 1000) / 1000, unexec };
}

/**
 * 运行金丝雀。返回值本身就是一条 L1 判决，会被写进判据记录里，
 * 因此「判据是否可信」这件事是可查询、可审计的，而不是口头保证。
 *
 * @param criteria 仅用于自证：允许传入「被削弱/被替换」的判据集，验证金丝雀
 *                 能否把永真闸抓出来。生产调用不传，固定用 L0_CRITERIA ——
 *                 否则就成了「改口径迁就结果」，正是宣言明令禁止的。
 * @param semantic 传入时额外跑 L2 合成样本：判据塔一旦接上语义层，
 *                 它就必须同样被自证覆盖，否则 L1 的「成立」只覆盖了半座塔。
 */
export function runCanary(
  thresholds: L0Thresholds = DEFAULT_L0_THRESHOLDS,
  criteria: L0Criterion[] = L0_CRITERIA,
  semantic?: SemanticAssessor,
): CanaryOutcome {
  const semanticOutcome = semantic ? runSemanticCanary(semantic) : null;
  const cases = CANARY_CASES.map((c) => {
    const { score, unexec } = scoreCase(c, thresholds, criteria);
    return { name: c.name, expected: c.expected, score, unexec };
  });

  const goodScores = cases.filter((c) => c.expected === 'good' && c.score !== null).map((c) => c.score!);
  const badScores = cases.filter((c) => c.expected === 'bad' && c.score !== null).map((c) => c.score!);

  // 任何「已知好」样本出现 unexec，说明样本本身没覆盖到全部判据，金丝雀失效。
  const goodUnexec = cases.some((c) => c.expected === 'good' && c.unexec.length > 0);
  const noGood = goodScores.length === 0;
  const noBad = badScores.length === 0;

  if (goodUnexec || noGood || noBad) {
    return {
      verdict: {
        layer: 'L1',
        criterion: 'canary.discrimination',
        status: 'unexec',
        detail: goodUnexec
          ? '金丝雀样本未覆盖全部 L0 判据（已知好样本出现 unexec），判别力无法验证'
          : '金丝雀样本不足，判别力无法验证',
      },
      goodScore: 0,
      badScore: 0,
      cases,
      semantic: semanticOutcome,
    };
  }

  const goodScore = round3(avg(goodScores));
  const badScore = round3(avg(badScores));
  const gap = round3(goodScore - badScore);

  const reasons: string[] = [];
  if (goodScore < CANARY_THRESHOLDS.minGoodScore) {
    reasons.push(`已知好样本均分 ${goodScore} 低于 ${CANARY_THRESHOLDS.minGoodScore}（判据过严）`);
  }
  if (badScore > CANARY_THRESHOLDS.maxBadScore) {
    reasons.push(`已知坏样本均分 ${badScore} 高于 ${CANARY_THRESHOLDS.maxBadScore}（判据永真）`);
  }
  if (gap < CANARY_THRESHOLDS.minGap) {
    reasons.push(`好坏差距 ${gap} 小于 ${CANARY_THRESHOLDS.minGap}（判别力不足）`);
  }
  // L2 判错与 L0 判错同等严重：语义层给出假绿会直接让 fail 判决消失。
  if (semanticOutcome && !semanticOutcome.ok) {
    reasons.push(semanticOutcome.detail);
  }

  return {
    verdict: {
      layer: 'L1',
      criterion: 'canary.discrimination',
      status: reasons.length === 0 ? 'pass' : 'fail',
      score: gap,
      detail:
        reasons.length === 0
          ? `判别力成立：好 ${goodScore} / 坏 ${badScore} / 差距 ${gap}${semanticOutcome ? `；${semanticOutcome.detail}` : ''}`
          : reasons.join('；'),
    },
    goodScore,
    badScore,
    cases,
    semantic: semanticOutcome,
  };
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
