/**
 * Update service — the `Update` step of the reinforcement loop (强化内核宣言第1节):
 *
 *   Improve(π) = π --Act--> τ --Judge--> r --Update--> π'
 *
 * Responsibilities:
 *  - turn a judgment r (an increment) into a new π' (append-only version);
 *  - never mutate the metric口径 of the Judges to flatter the result;
 *  - every mutation is rollable (no DELETE — rollback appends a revert version);
 *  - expose getPolicy() so the NEXT Act can read π' (closes the C2 open-loop).
 *
 * This is the minimal closed loop, NOT full self-modifying RL. The π surface is
 * deliberately small (lessons + thresholds) and the only consumer wired today is
 * the agent system prompt (see system-prompt.ts buildSystemPrompt).
 */

import type { Db } from '../../repositories/db.js';
import {
  PolicyRepository,
  EMPTY_POLICY,
  type Policy,
  type PolicyVersionRow,
} from '../../repositories/policy.repository.js';
import type { JudgeRepository } from '../../repositories/judge.repository.js';
import type { JudgeRunResult } from '../judge/types.js';
import {
  DEFAULT_INJECTION_BUDGET,
  injectionChars,
  selectInjections,
  type InjectionBudget,
  type LessonStat,
} from './lesson-budget.js';

export interface PolicyIncrement {
  /** 新增经验/提示（去重后追加）。 */
  addLessons?: string[];
  /** 移除已有经验（按精确文本匹配）。 */
  removeLessons?: string[];
  /** 覆盖/新增阈值。 */
  setThresholds?: Record<string, number>;
}

/** π 经验上限：超出时淘汰最无效的，避免无限增长污染上下文。 */
const MAX_LESSONS = 50;

/**
 * 本轮的注入视图：**存储侧不动**（policy 里仍是完整 lessons），只回答
 * 「这一轮实际要往 system prompt 里放哪几条」。
 *
 * 记账（recordInjections）与提示词（buildSystemPrompt）必须吃同一个数组，
 * 这就是把两件事收进同一个返回值的唯一理由。
 */
export interface InjectionView {
  /** 完整 π（lessons 未被裁剪）。消费者若要注入，须显式换成 lessons。 */
  policy: Policy;
  /** 已排序、已裁剪到预算内的经验。 */
  lessons: string[];
  /** 存在但本轮没注入的经验（按同一排序口径）。 */
  evicted: string[];
  /** lessons 的实际注入字符数（含序号前缀与换行，不含段落头）。 */
  chars: number;
  /** 读到的是哪一版 π（注入记账用它标注）。 */
  version: number;
}

/**
 * 判据 → 经验文案。每条判据对应一种真实失败模式，而不是一句万能套话。
 * 这是「r 必须来自 Judge」的落地：经验由判据决定，不由「看起来不错」决定。
 */
const CRITERION_LESSON: Record<string, string> = {
  'tool.success_rate':
    '此前任务中工具调用成功率偏低。执行前先核对参数、沙箱路径与权限边界，避免同一类失败重复发生。',
  'task.terminal':
    '此前任务出现过未收敛就结束的情况（迭代或预算耗尽、被中止）。应先确认关键信息再动手，尽早收敛到结果。',
  'loop.health':
    '此前任务触发过熔断，说明同一工具被反复重试。失败后应先换策略或换工具，不要重复同一调用。',
  'approval.friction':
    '此前任务的审批拒绝率偏高，说明操作意图与用户权限边界不符。先说明意图，或改用影响范围更小的参数。',
  'budget.efficiency':
    '此前任务 token 消耗接近或超过预算。应减少冗余读取与重复调用，一次取够所需信息。',
};

export class UpdateService {
  private readonly repo: PolicyRepository;

  /**
   * 延迟绑定的有效性来源（照抄 JudgeService.setThresholdsProvider 的模式）。
   * Update 需要读 Judge 的 `lessonEffectiveness`，而 Judge 需要读 π 的 thresholds，
   * 构造期互相注入会成环 —— 用 setter 在一处断开。
   */
  private effectivenessProvider?: () => LessonStat[] | null;

  /** 注入预算；默认 8 条 / 480 字符（见 lesson-budget.ts 的取值理由）。 */
  private injectionBudget: InjectionBudget = { ...DEFAULT_INJECTION_BUDGET };

  /**
   * @param judgeRepo 可选。提供时按「经验实际有效性」淘汰落后经验；
   *                  缺省时退化为按新旧淘汰（保持历史行为，向后兼容）。
   */
  constructor(
    db: Db,
    private readonly judgeRepo?: JudgeRepository,
  ) {
    this.repo = new PolicyRepository(db);
  }

  /**
   * 绑定「经验有效性」的来源（runtime 在构造完 JudgeService 后调用）。
   * 返回 null 表示「排序依据不可得」——getInjectableView 据此退化为全量注入。
   */
  setEffectivenessProvider(fn: () => LessonStat[] | null): void {
    this.effectivenessProvider = fn;
  }

  /** 设置注入预算。入参会被拷贝：外部随后改自己的对象不该动态改变已生效的预算。 */
  setInjectionBudget(budget: InjectionBudget): void {
    this.injectionBudget = { maxLessons: budget.maxLessons, maxChars: budget.maxChars };
  }

  /**
   * 单一求值点：本轮该注入什么。
   *
   * 关键约束：`getPolicy()` 永远返回完整 lessons —— 裁剪只发生在注入视图里，
   * 绝不写回 policy（否则「存储 50 条」会悄悄退化成「存储 8 条」，回滚与
   * 事后评估都会失真）。
   *
   * 退化路径：没有 effectivenessProvider，或它抛错时，**全量注入**而不是按原序
   * 截断。理由：截断需要排序依据，没有依据时「取前 8 条」等于按追加顺序偏袒
   * 老经验 —— 那正是本次要修的毛病。宁可这一轮贵一点，也不要按无依据的顺序
   * 给出一个有依据的样子。
   */
  getInjectableView(): InjectionView {
    const policy = this.getPolicy();
    const version = this.currentVersion();
    const stats = this.readEffectiveness();

    if (!stats) {
      const lessons = [...policy.lessons];
      return { policy, lessons, evicted: [], chars: injectionChars(lessons), version };
    }

    const selection = selectInjections(policy.lessons, this.injectionBudget, stats);
    return {
      policy,
      lessons: selection.lessons,
      evicted: selection.evicted,
      chars: selection.chars,
      version,
    };
  }

  /** π'：被下一轮 Act 消费。 */
  getPolicy(): Policy {
    return this.repo.getCurrent().policy;
  }

  /**
   * 只读暴露注入预算（返回拷贝，不是引用）。
   *
   * 洞察视图需要它才能回答「裁掉这么多是否合理」—— 只给 `chars` 一个孤立数字，
   * 读的人无法判断 480 是宽还是紧。返回拷贝是为了让调用方改不动内部状态。
   */
  getInjectionBudget(): InjectionBudget {
    return { maxLessons: this.injectionBudget.maxLessons, maxChars: this.injectionBudget.maxChars };
  }

  /** 当前 π 的版本号（无版本时为 0）。注入记账用它标注「读到的是哪一版」。 */
  currentVersion(): number {
    return this.repo.getCurrent().version;
  }

  /**
   * Update 步骤：把判决 r 的增量并入 π → π'。
   * 每次修改产生新版本（可回滚、可审计）。addLessons 自动去重。
   */
  applyUpdate(increment: PolicyIncrement, sourceJudgment?: string): Policy {
    const { policy: current, version } = this.repo.getCurrent();
    const next: Policy = {
      lessons: this.mergeLessons(current.lessons, increment),
      thresholds: { ...current.thresholds, ...(increment.setThresholds ?? {}) },
    };
    this.repo.insertVersion(next, version, sourceJudgment ?? null);
    return next;
  }

  /**
   * 从一次 Judge 判决中学习：只有 fail 判据才产生经验（pass 不产生噪声）。
   *
   * 与旧实现的区别：旧版只要「有工具失败」就写同一条模板；这里经验由
   * 具体判据决定，因此不同失败模式得到不同指导，且 source_judgment 指向
   * judge run id，可回溯「这条经验是哪次判决教出来的」。
   *
   * @returns 新 π；无 fail 判据时返回 null（不产生无意义的版本）。
   */
  applyFromJudge(run: JudgeRunResult, runId: number): Policy | null {
    const failed = run.verdicts.filter((v) => v.status === 'fail');
    if (failed.length === 0) return null;

    const seen = new Set<string>();
    const addLessons: string[] = [];
    for (const v of failed) {
      const lesson = CRITERION_LESSON[v.criterion];
      if (!lesson || seen.has(lesson)) continue;
      seen.add(lesson);
      addLessons.push(lesson);
    }
    if (addLessons.length === 0) return null;

    return this.applyUpdate({ addLessons }, `judge:run:${runId}:${failed.map((v) => v.criterion).join(',')}`);
  }

  /** 把一次判决换算成可读的经验增量（供展示/测试，不落库）。 */
  lessonsFor(run: JudgeRunResult): string[] {
    const out: string[] = [];
    for (const v of run.verdicts) {
      if (v.status !== 'fail') continue;
      const lesson = CRITERION_LESSON[v.criterion];
      if (lesson && !out.includes(lesson)) out.push(lesson);
    }
    return out;
  }

  /**
   * 回滚：以「追加一个内容等于目标版本的新版本」回到某次历史 π。
   * 历史不可变（不删除），回滚本身也是一条可审计记录。
   */
  rollbackTo(version: number): Policy {
    const target = this.repo.getVersion(version);
    if (!target) throw new Error(`POLICY_VERSION_NOT_FOUND:${version}`);
    const { policy: current, version: currentVersion } = this.repo.getCurrent();
    if (currentVersion === version || JSON.stringify(target) === JSON.stringify(current)) {
      return current;
    }
    this.repo.insertVersion(target, version, `rollback:from-v${currentVersion}-to-v${version}`);
    return target;
  }

  listVersions(): PolicyVersionRow[] {
    return this.repo.listVersions();
  }

  /**
   * 读排序依据。任何异常都收敛成 null（= 退化全量注入）：
   * 有效性数据源故障不该让本轮注入变成空集，更不该把异常抛进 agent 主循环。
   */
  private readEffectiveness(): LessonStat[] | null {
    if (!this.effectivenessProvider) return null;
    try {
      return this.effectivenessProvider();
    } catch {
      return null;
    }
  }

  private mergeLessons(current: string[], increment: PolicyIncrement): string[] {
    const out = [...current];
    for (const lesson of increment.addLessons ?? []) {
      const trimmed = lesson.trim();
      if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    }
    for (const lesson of increment.removeLessons ?? []) {
      const idx = out.indexOf(lesson.trim());
      if (idx >= 0) out.splice(idx, 1);
    }
    if (out.length <= MAX_LESSONS) return out;
    return this.evict(out, out.length - MAX_LESSONS);
  }

  /**
   * 超限淘汰：优先淘汰「注入后通过率最低」的经验，而不是机械地丢最旧。
   *
   * 旧实现是 FIFO —— 当所有经验都来自同一模板时，真正有效的经验会被
   * 最近一条噪声顶出去。按有效性淘汰才让 π 具备「越用越准」的可能。
   *
   * 没有有效性数据（pending）的经验按中性 0.5 处理并优先保留：
   * 没被验证过不等于无效，不该被未验证的新经验挤掉。
   */
  private evict(lessons: string[], overflow: number): string[] {
    const fifo = () => lessons.slice(lessons.length - MAX_LESSONS);
    if (!this.judgeRepo) return fifo();

    let stats: Map<string, number | null>;
    try {
      stats = new Map(this.judgeRepo.lessonEffectiveness().map((e) => [e.lesson, e.passRate]));
    } catch {
      // 有效性数据源异常时不能连累主流程：退化为历史行为。
      return fifo();
    }

    const ranked = lessons
      .map((lesson, index) => ({ lesson, index, rate: stats.get(lesson) ?? 0.5 }))
      .sort((a, b) => a.rate - b.rate || a.index - b.index);
    const drop = new Set(ranked.slice(0, overflow).map((r) => r.lesson));
    return lessons.filter((l) => !drop.has(l));
  }
}

export { EMPTY_POLICY };
