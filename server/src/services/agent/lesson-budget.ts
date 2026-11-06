/**
 * π 经验注入预算与排序（纯函数，无 IO）。
 *
 * 解决的问题：存储侧（UpdateService.evict）最多留 50 条经验，注入侧却把
 * **全量**塞进 system prompt，且顺序恒等于追加顺序。后果有两个，都很实际：
 *
 *  1. 每轮常驻的提示词开销没有上限（50 条 × 约 54 字符 ≈ 2700 字符，
 *     而基座提示词本身才 522 字符 —— 经验段比身份与规则加起来还贵）；
 *  2. 老经验恒占前位，与它是否真的有效无关。最该被看见的高效经验可能排在
 *     第 40 位，而一条从未生效过的高龄经验稳坐第 1 位。
 *
 * 这里把「注入多少」与「先注入谁」变成两个显式的、可测的决策：
 *  - 排序依据是**证据**（Laplace 平滑后的通过率），不是年龄；
 *  - 证据相同者按「被注入次数最少」优先 —— 这是冷启动轮转的唯一机制，
 *    否则无样本的新经验永远排在最后，也就永远拿不到样本（自证式饿死）；
 *  - 裁剪是排序结果的前缀，受条数与字符两个闸约束。
 *
 * 本模块刻意不 import 任何东西（不碰仓储、不碰 env）：预算与排序是可纯函数
 * 论证的行为，混进 IO 之后就只能靠集成测试猜了。
 */

/** 注入预算。两个字段都用 0 表示「不限」（与 config/env.ts 的惯例一致）。 */
export interface InjectionBudget {
  /** 本轮最多注入几条经验；0 = 不限。 */
  maxLessons: number;
  /** 本轮注入文本（含序号前缀）的字符上限；0 = 不限。 */
  maxChars: number;
}

/**
 * 默认预算：8 条 / 480 字符。
 *
 * 480 是刻意选的：它约等于基座提示词（522 字）的量级，使经验段的常驻开销
 * 不超过「身份+规则」本身。8 条则保证轮转速度——证据最差的一批会被自然
 * 顶出去，而不是靠 50 条一起稀释。
 */
export const DEFAULT_INJECTION_BUDGET: InjectionBudget = { maxLessons: 8, maxChars: 480 };

/**
 * 一条经验的证据。
 *
 * 契约修正：初稿是 `{ lesson, passRate, injected }`，改成了 `{ lesson, passes, fails, injected }`。
 * 理由是 `passRate` 是**平滑前**的比率，从它反推计数既丢精度又得多做一次除法；
 * 而仓储（JudgeRepository.lessonEffectiveness）本来就返回 passes/fails 与 injected，
 * 直接用原始计数既省事又让「先验强度」这类参数留在排序侧（改先验不必改仓储）。
 */
export interface LessonStat {
  lesson: string;
  passes: number;
  fails: number;
  injected: number;
}

/** 排序后的经验（LessonStat 的超集，多带一个可解释的分数）。 */
export interface RankedLesson extends LessonStat {
  /** 排序分：Laplace 平滑后的通过率。仅用于排序与排查，不落库。 */
  score: number;
}

export interface InjectionSelection {
  /** 已排序、已裁剪，可直接注入。 */
  lessons: string[];
  /** 存在但本轮没注入（按与 lessons 相同的排序口径给出）。 */
  evicted: string[];
  /** lessons 的实际注入字符数（含 `序号. ` 前缀与条目间换行，不含段落头）。 */
  chars: number;
}

/** 无已知结果时的中性分：不知道好坏就按 0.5 处理（与 UpdateService.evict 同口径）。 */
const NEUTRAL_SCORE = 0.5;
/** Laplace 先验强度：等价于「先看过 1 通过 1 失败」。 */
const PRIOR_STRENGTH = 2;

/**
 * 单条经验的分值：`(passes + 1) / (passes + fails + 2)`。
 *
 * 这是 Laplace（加一）平滑，不是裸比率。裸比率下「1 通过 / 1 次」会得到 1.0，
 * 与「30 通过 / 30 次」并列，于是单次侥幸能顶掉长期稳定的经验；平滑把
 * 小样本压回 0.5 附近，样本越多才越敢偏离。
 *
 * `passes + fails === 0`（从没被验证，或全是 pending）时返回 0.5 而不是 0：
 * 没被验证过不等于无效（这是 UpdateService.evict 已确立的口径，这里沿用，
 * 避免两处对「未知」给出相反的解读）。
 */
export function lessonScore(passes: number, fails: number): number {
  const known = passes + fails;
  if (known <= 0) return NEUTRAL_SCORE;
  return (passes + 1) / (known + PRIOR_STRENGTH);
}

/** 注入时的单行形态。这是字符预算的唯一计量口径（改这里才会改变 chars）。 */
export function renderLessonLine(index: number, lesson: string): string {
  return `${index + 1}. ${lesson}`;
}

/** 一段经验的注入字符数：与 buildSystemPrompt 里 join('\n') 的结果逐字符相等。 */
export function injectionChars(lessons: string[]): number {
  return lessons.map((lesson, i) => renderLessonLine(i, lesson)).join('\n').length;
}

/**
 * 全序排序（不允许并列）。三级键：
 *  1. score DESC —— 有效者先上；
 *  2. injected ASC —— 证据相同者让「最没被用过」的先上（冷启动轮转）；
 *  3. lesson 文本 ASC —— 确定性锚点，保证同样的输入永远同样的顺序。
 *
 * 返回 LessonStat[]，其中没出现在 `stats` 里的经验按「零证据」补零：
 * 缺证据不能等于「证据为负」，否则新经验会被永久排在最后。
 */
export function rankLessons(lessons: string[], stats: LessonStat[]): RankedLesson[] {
  const byLesson = new Map<string, LessonStat>();
  for (const stat of stats) byLesson.set(stat.lesson, stat);

  return uniqueLessons(lessons)
    .map((lesson) => {
      const stat = byLesson.get(lesson);
      const passes = nonNegative(stat?.passes);
      const fails = nonNegative(stat?.fails);
      return {
        lesson,
        passes,
        fails,
        injected: nonNegative(stat?.injected),
        score: lessonScore(passes, fails),
      };
    })
    .sort(compareRanked);
}

/**
 * 选本轮要注入的经验：先排序，再按顺序过两道闸（条数、字符）。
 *
 * 字符闸一旦拦住就停止（而不是跳过它继续试后面的）：这样「哪些经验被注入」
 * 恒是排序结果的一个**前缀**—— rank i 被注入 ⇒ 所有 rank < i 都被注入。
 * 前缀性质让注入集合可以用一句「前 K 条」解释，也让「同一条经验为什么这轮
 * 没进」只有一个原因（排名不够），不必再去比对长度分布。
 */
export function selectInjections(
  lessons: string[],
  budget: InjectionBudget,
  stats: LessonStat[],
): InjectionSelection {
  const maxLessons = normalizeLimit(budget.maxLessons);
  const maxChars = normalizeLimit(budget.maxChars);
  const ranked = rankLessons(lessons, stats);

  const selected: string[] = [];
  let chars = 0;
  for (const row of ranked) {
    if (maxLessons > 0 && selected.length >= maxLessons) break;

    const lineChars = renderLessonLine(selected.length, row.lesson).length;
    // 条目之间有一个换行；首条没有。
    const projected = selected.length === 0 ? lineChars : chars + 1 + lineChars;
    if (selected.length > 0 && maxChars > 0 && projected > maxChars) break;
    // 首条例外：哪怕它单独就越过字符闸也照样注入。预算再小也不该让注入恒为空
    // —— 空注入等于把闭环关掉，超一点点远比「一条都不给」安全。
    selected.push(row.lesson);
    chars = projected;
  }

  const selectedSet = new Set(selected);
  return {
    lessons: selected,
    evicted: ranked.filter((row) => !selectedSet.has(row.lesson)).map((row) => row.lesson),
    chars,
  };
}

/** 全序比较器：score DESC → injected ASC → 文本 ASC。 */
function compareRanked(a: RankedLesson, b: RankedLesson): number {
  if (a.score !== b.score) return b.score - a.score;
  // injected ASC 是冷启动轮转的唯一机制：一条经验被注入过一次后，
  // 在它拿到判决之前就会被「从没被注入过」的经验顶到后面。
  // 这是必要代价 —— 不轮转它永远拿不到样本，就永远不会有判决。
  // 代价的上限是「一次实验」：被顶掉的经验已经在 policy_injections 里留了痕，
  // 下一次轮到它时 injected 已经 > 0，不会再被无限推迟。
  if (a.injected !== b.injected) return a.injected - b.injected;
  // 用码元比较而不是 localeCompare：后者依赖 ICU/locale，同一份数据在不同
  // 环境下可能排出不同顺序，那「确定性锚点」就不成立了。
  return a.lesson < b.lesson ? -1 : a.lesson > b.lesson ? 1 : 0;
}

/** 去重但保留首次出现的位置：同一条经验注入两次会既占两行预算又重复记账。 */
function uniqueLessons(lessons: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const lesson of lessons) {
    if (seen.has(lesson)) continue;
    seen.add(lesson);
    out.push(lesson);
  }
  return out;
}

/** 非法/负数一律按「不限」处理：配置写错时宁可多注入，也不要静默注入空。 */
function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return value > 0 ? Math.floor(value) : 0;
}

function nonNegative(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return value;
}
