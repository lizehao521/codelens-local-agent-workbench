/**
 * 测量探针的评分表（answer rubric）—— 让目标指标变成可执行的步长分数。
 *
 * 为什么需要一张表而不是「词项覆盖率」：
 *   旧口径把整段目标切成几十个 2-gram 词项，再统计回答里出现了多少。
 *   它对「公式型/结构化」问题天然失效 —— 正确答案是 `Improve(π) = π --Act--> τ …`，
 *   不会复述目标里的「闭环」「完整」「写出」这些词，覆盖率永远卡在 0.5 左右。
 *   更糟的是它奖励篇幅：写得越长分越高，与「答得对不对」无关。
 *
 * 这张表把每个问题定义成若干**必须出现的要点**（正则），逐项判定：
 *   · 一项的全部要点都出现 → 该项得分；
 *   · 分数 = 命中项 / 总项数（本表 5 项 → 步长 0.2）；
 *   · 未命中的项连同要点名一起写进 detail —— 归因器据此能写出可执行的教训。
 *
 * 纯函数、无 IO、无模型参与：同一份回答必然得到同一个分数（可复算）。
 */

export interface RubricItem {
  /** 题号（1 起），与探针里的编号对应。 */
  id: number;
  /** 该项在说什么，写进 detail 给归因器看。 */
  label: string;
  /** 必须出现的要点；全部命中才算这一项答对。 */
  patterns: RegExp[];
}

export interface ProbeRubric {
  id: string;
  /** 命中该正则才启用这张表（避免误伤普通任务）。 */
  trigger: RegExp;
  items: RubricItem[];
}

/**
 * 强化内核读本探针的评分表（kernel-declaration@v2）。
 *
 * 要点取自原文表述并放宽同义写法：只看「有没有答到那个概念」，不要求逐字复述。
 *
 * 试过但被否决的 v3（保留结论，避免重走）：
 *   把题换成「全文多少行、某词出现几次」这类计量题。两类失败：
 *   1. 模型会为统计反复读文件（实测 8 次工具调用后 budget_exhausted），
 *      最终回答为空 —— 探针本身把 Agent 逼进工具死循环，量到的是循环不是能力；
 *   2. 「行数」真值有歧义（末尾换行算不算），不是可靠的答案键。
 *
 * 当前状态（必须如实记录）：v1/v2 两套概念题都被首代 5/5 打满。按读本铁律
 * 「饱和意味着该扩任务空间，而不是改判据让它继续绿」，下一步该加的是**有真实
 * 失败模式的任务族**（代码改动 + 真跑测试），而不是继续在这里换题面。
 */
export const KERNEL_DECLARATION_RUBRIC: ProbeRubric = {
  id: 'kernel-declaration@v2',
  trigger: /逐条回答下面\s*5\s*个问题/,
  items: [
    {
      id: 1,
      label: '四条铁律',
      patterns: [/c1/i, /c2/i, /c3/i, /c4/i],
    },
    {
      id: 2,
      label: '判据塔分层',
      patterns: [/l0/i, /l2/i, /l3/i],
    },
    {
      id: 3,
      label: '工具生命周期 6 步',
      patterns: [/触发/, /回收/],
    },
    {
      id: 4,
      label: '沉淀三问',
      patterns: [/哪一类|哪类/, /(变成|转化为|沉淀).{0,12}π|π.{0,12}(修改|沉淀)/, /不造工具|不再造|无需再造/],
    },
    {
      id: 5,
      label: '饱和后的动作',
      patterns: [/(扩|加).{0,12}(任务空间|新家族)/, /(不许|不是|而非).{0,16}(改判据|让它继续绿|放宽)/],
    },
  ],
};

export const PROBE_RUBRICS: ProbeRubric[] = [KERNEL_DECLARATION_RUBRIC];

export interface RubricScore {
  /** 是否适用（目标命中 trigger）。false 时调用方应退回通用覆盖度口径。 */
  applicable: boolean;
  rubricId: string;
  hits: number;
  count: number;
  /** hits / count（0..1）。不适用时为 0。 */
  score: number;
  /** 未命中的项（题号 + 名称），供归因器写出「漏了哪一条」。 */
  missing: Array<{ id: number; label: string }>;
}

/**
 * 按评分表打分。目标不匹配任何 rubric 时返回 applicable=false。
 *
 * 命中判定在**全篇回答**上做，不要求回答自己编号：模型可能用表格或段落作答，
 * 强制编号会把「答对了但格式不同」判成漏答。
 */
export function scoreRubric(goal: string, finalAnswer: string): RubricScore {
  const rubric = PROBE_RUBRICS.find((r) => r.trigger.test(goal));
  if (!rubric) {
    return { applicable: false, rubricId: '', hits: 0, count: 0, score: 0, missing: [] };
  }
  const missing: Array<{ id: number; label: string }> = [];
  let hits = 0;
  for (const item of rubric.items) {
    if (item.patterns.every((p) => p.test(finalAnswer))) hits += 1;
    else missing.push({ id: item.id, label: item.label });
  }
  return {
    applicable: true,
    rubricId: rubric.id,
    hits,
    count: rubric.items.length,
    score: Math.round((hits / rubric.items.length) * 1000) / 1000,
    missing,
  };
}
