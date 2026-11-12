/**
 * iteration-gate.ts — 每轮迭代的量化判据与去留决策。
 *
 * ── 它回答什么问题 ────────────────────────────────────────
 * 「这一轮算不算达标？接下来是继续、重试、回滚、还是要人？」——
 * 在这之前，这个问题由脚本里的 if 语句零散回答（`if (fence.ok) upgrade else 继续下一轮`），
 * 于是有三个说不清的地方：
 *   1. **「没跑到」和「跑红了」混在一个 false 里**（宣言 C4：UNEXEC 既不等于 PASS 也不等于 FAIL）；
 *   2. **护栏变差没有硬出口**：指标回退时仍然只是「再来一轮」，而再来一轮很可能继续回退；
 *   3. **越权改动没有触发条件**：改成 `allowed` 之外的文件只报 WARN，不阻断。
 *
 * 这里把它收敛成一张**判据表 + 一个决策函数**：每条判据有阈值、有取值、有违反后的动作，
 * 输出是可枚举的五个决策之一，前端据此渲染，人据此复核。
 *
 * ── 五个决策 ─────────────────────────────────────────────
 *   continue  本轮达标，进入下一代
 *   retry     未达标但可再试（同域、同题、带诊断）
 *   rollback  必须回滚（护栏回退 / 越权 / 拒收）——**不做"再试一次"的自我安慰**
 *   escalate  升级人审（触及需要批的域，或决策依据不足）
 *   halt      停机（判据层被动 / 连续同码）
 *
 * ── 为什么 rollback 优先于 retry ──────────────────────────
 * 「再试一次」的前提是**上一轮没把地基弄坏**。护栏指标回退、改动越域、
 * manifest 被拒收，这三种情况下盘上的状态已经不可信，
 * 继续在坏地基上叠加改动，只会把问题埋得更深。
 */

import type { ChangeDomainId, IterationTrigger } from './change-domain.js';

/** 单道闸的结论。**三态**：跑了通过 / 跑了不过 / 根本没跑。 */
export type GateStatus = 'pass' | 'fail' | 'unexec';

export interface GateResult {
  /** 闸的名字，与围栏输出一一对应。 */
  id: string;
  status: GateStatus;
  /** unexec 时必须写清为什么没跑（宣言 C4：不许把没跑说成通过）。 */
  detail?: string;
}

/** RSI 内核的六态判定（与 rules-contract 的 states 一致）。 */
export type RsiVerdict =
  | 'improved'
  | 'not_improved'
  | 'refused'
  | 'undecidable'
  | 'skipped'
  | 'error';

export type IterationDecision = 'continue' | 'retry' | 'rollback' | 'escalate' | 'halt';

export interface IterationInput {
  iterationId: string;
  trigger: IterationTrigger;
  domain: ChangeDomainId;
  attempts: number;
  maxAttempts: number;

  /** 内核给出的跨代判定。首次运行可能为 skipped。 */
  verdict: RsiVerdict;
  /** 七道闸。 */
  gates: GateResult[];
  /** 护栏指标变差的条数（来自 R5 的 guardRegressed）。 */
  guardRegressed: number;
  /** 覆盖率：本轮真执行到的判据占比。 */
  coverage: number;
  /** 越域改动数：实际改动里不在 allowed 白名单内的文件数。 */
  outOfScopeChanges: number;
  /** 是否已获人工批准（仅对需要批的域有意义）。 */
  humanApproved: boolean;
}

export interface CriterionOutcome {
  id: string;
  name: string;
  /** 阈值（人能看懂的写法）。 */
  threshold: string;
  /** 本轮实际取值。 */
  actual: string;
  status: GateStatus;
  /** 不满足时建议的动作。 */
  onFail: IterationDecision | null;
}

export interface IterationResult {
  decision: IterationDecision;
  /** 一句话结论，给前端顶部展示。 */
  headline: string;
  criteria: CriterionOutcome[];
  /** 必须回滚的理由（decision=rollback 时非空）。 */
  rollbackReasons: string[];
  /** 置信度：0–1。依据不足（unexec 多）时偏低，用来决定要不要升级人审。 */
  confidence: number;
}

/** 覆盖率下限，与 judge/types.ts 的口径一致（那边是 0.5）。 */
const MIN_COVERAGE = 0.5;

/**
 * 评估一轮迭代。
 *
 * **纯函数**：同样的输入永远同样的结论。所以它可以被单测覆盖，
 * 也可以拿历史账本回放（"如果当时用这套判据，结论会是回滚还是继续"）。
 */
export function evaluateIteration(input: IterationInput): IterationResult {
  const criteria: CriterionOutcome[] = [];
  const rollbackReasons: string[] = [];

  const add = (
    id: string,
    name: string,
    threshold: string,
    actual: string,
    passed: boolean,
    onFail: IterationDecision | null,
    unexec = false,
    unexecDetail?: string,
  ): void => {
    criteria.push({
      id,
      name,
      threshold,
      actual: unexecDetail ? `${actual}（${unexecDetail}）` : actual,
      status: unexec ? 'unexec' : passed ? 'pass' : 'fail',
      onFail,
    });
  };

  // ── G1 跨代判定 ───────────────────────────────────────────
  add(
    'G1',
    '跨代判定为 improved',
    'verdict = improved',
    `verdict = ${input.verdict}`,
    input.verdict === 'improved',
    input.verdict === 'refused' || input.verdict === 'error' ? 'rollback' : 'retry',
    input.verdict === 'skipped',
    input.verdict === 'skipped' ? '首次运行无上一代可对账' : undefined,
  );

  // ── G2 护栏不得回退（硬判据）───────────────────────────────
  add(
    'G2',
    '护栏指标不回退',
    'guardRegressed = 0',
    `guardRegressed = ${input.guardRegressed}`,
    input.guardRegressed === 0,
    'rollback',
  );
  if (input.guardRegressed > 0) {
    rollbackReasons.push(`${input.guardRegressed} 条护栏指标变差 —— 继续叠加改动只会把回退埋得更深`);
  }

  // ── G3 围栏无 fail、无 unexec ─────────────────────────────
  const fails = input.gates.filter((g) => g.status === 'fail');
  const unexecs = input.gates.filter((g) => g.status === 'unexec');
  add(
    'G3',
    '围栏全部通过（且没有未执行的闸）',
    'fail = 0 且 unexec = 0',
    `fail = ${fails.length}，unexec = ${unexecs.length}`,
    fails.length === 0 && unexecs.length === 0,
    fails.length > 0 ? 'retry' : 'escalate',
    fails.length === 0 && unexecs.length > 0,
    unexecs.length > 0 ? `未执行：${unexecs.map((g) => g.id).join('、')}` : undefined,
  );

  // ── G4 改动不得越域 ──────────────────────────────────────
  add(
    'G4',
    '改动全部在授权域内',
    'outOfScopeChanges = 0',
    `outOfScopeChanges = ${input.outOfScopeChanges}`,
    input.outOfScopeChanges === 0,
    'rollback',
  );
  if (input.outOfScopeChanges > 0) {
    rollbackReasons.push(`${input.outOfScopeChanges} 个改动落在白名单之外 —— 越权改动必须先撤销再谈下一步`);
  }

  // ── G5 覆盖率 ────────────────────────────────────────────
  add(
    'G5',
    '判据执行覆盖率达标',
    `coverage ≥ ${MIN_COVERAGE}`,
    `coverage = ${input.coverage.toFixed(2)}`,
    input.coverage >= MIN_COVERAGE,
    'retry',
  );

  // ── G6 尝试次数：耗尽后的动作要按"本轮有没有做对"分叉 ──────
  //
  // 原来这里一律 onFail='rollback'，于是「第 3/3 次把题做对了、其余闸全绿」
  // 也会被判定为"必须回滚"——把一个已验证的改进撤掉，是比留着它更大的损失。
  // 预算耗尽只说明"这题花光了重试次数"，它和"地基被弄坏"（G2 护栏回退 /
  // G4 越域 / verdict=refused）不是一回事，后者才配 rollback。
  const priorFail = criteria.some((c) => c.status === 'fail');
  const priorUnexec = criteria.some((c) => c.status === 'unexec');
  const exhaustedButClean =
    input.attempts >= input.maxAttempts &&
    input.verdict === 'improved' &&
    !priorFail &&
    !priorUnexec &&
    input.outOfScopeChanges === 0 &&
    input.guardRegressed === 0;

  add(
    'G6',
    '尝试次数未耗尽',
    `attempts < ${input.maxAttempts}`,
    `attempts = ${input.attempts}`,
    input.attempts < input.maxAttempts,
    input.attempts >= input.maxAttempts ? (exhaustedButClean ? 'escalate' : 'rollback') : null,
    false,
    exhaustedButClean
      ? `预算已用尽但本轮已改进、其余闸全绿 ${input.attempts}/${input.maxAttempts}`
      : undefined,
  );
  if (input.attempts >= input.maxAttempts && !exhaustedButClean) {
    rollbackReasons.push(
      `重试预算已用尽（${input.attempts}/${input.maxAttempts}）且本轮未达标 —— 不保留半成品`,
    );
  }

  // ── 决策：按"从硬到软"的顺序取第一个命中的动作 ─────────────
  //
  // 顺序不是随便排的：越权与护栏回退必须压过一切"再试一次"的冲动，
  // 否则会出现「指标一直退、系统一直试」的死亡螺旋。
  const hardRollback = criteria.find((c) => c.status === 'fail' && c.onFail === 'rollback');
  const anyFail = criteria.find((c) => c.status === 'fail');

  // 需要人批的域但没批 → 升级，而不是直接跑
  const needsHuman =
    (input.domain === 'D2' || input.domain === 'D3') && !input.humanApproved;

  let decision: IterationDecision;
  let headline: string;

  if (needsHuman) {
    decision = 'escalate';
    headline = `${input.domain} 域改动需要人工批准后才能执行`;
  } else if (hardRollback) {
    decision = 'rollback';
    headline = `必须回滚：${rollbackReasons[0] ?? hardRollback.name}`;
  } else if (anyFail) {
    // 剩下的 fail 有各自的动作，不能一律当"可重试"：
    // 例如 G6 在"本轮已改进、只是预算用尽"时给的是 escalate，
    // 当作 retry 派下去只会在预算已满的情况下继续重派。
    if (anyFail.onFail === 'escalate') {
      decision = 'escalate';
      headline = `需人确认：${anyFail.name}（${anyFail.actual}）`;
    } else {
      decision = 'retry';
      headline = `未达标但可重试：${anyFail.name}`;
    }
  } else if (unexecs.length > 0) {
    // 没有 fail，但有闸没跑：不能判 continue（宣言 C4）
    decision = 'escalate';
    headline = `依据不足：${unexecs.length} 道闸未执行，不能判为达标`;
  } else {
    decision = 'continue';
    headline = '本轮达标，进入下一代';
  }

  // ── 置信度：unexec 越多越不可信 ───────────────────────────
  const total = input.gates.length || 1;
  const confidence = Math.max(
    0,
    Math.min(1, (input.gates.filter((g) => g.status === 'pass').length / total) * (input.coverage >= MIN_COVERAGE ? 1 : 0.6)),
  );

  return { decision, headline, criteria, rollbackReasons, confidence };
}

/** 决策的中文标签与色调，给前端直接用（避免前端再抄一份映射）。 */
export const DECISION_META: Record<
  IterationDecision,
  { label: string; tone: 'success' | 'warning' | 'danger' | 'muted'; action: string }
> = {
  continue: { label: '达标继续', tone: 'success', action: '升版本、进入下一代 Act' },
  retry: { label: '重试', tone: 'warning', action: '带诊断重派同一题（域与题不变）' },
  rollback: { label: '回滚', tone: 'danger', action: '还原到本轮回滚点，账本记 rolled_back' },
  escalate: { label: '待人审', tone: 'warning', action: '暂停自动迭代，等待人工批准或补足依据' },
  halt: { label: '停机', tone: 'danger', action: '停止自动迭代，交人工排查' },
};
