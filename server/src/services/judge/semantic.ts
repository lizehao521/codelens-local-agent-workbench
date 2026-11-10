/**
 * L2 语义判据（判据塔 v2）。
 *
 * L1 只能证明「机械判据能把已知好坏样本分开」，它看不见「回答是否真的完成了任务」。
 * L2 补的正是这一层：把 goal 与 finalAnswer 放在一起看。
 *
 * 三条设计约束（都是被上一轮缺陷逼出来的）：
 *  1. **同步纯函数**。judge() 是同步方法，注入异步评估器会让判决在 DB 事务里悬空。
 *     本期只做规则评估器；LLM 深判留接口不实现（不要写假实现冒充能力）。
 *  2. **同证据必同判决**。不读时间、locale、随机数、环境变量。否则 replay 不可能复现。
 *  3. **降级比误判安全**。凡是只能「怀疑」不能「证明」的信号（词项覆盖率），
 *     一律 abstain 并写进 score/detail 供观察，绝不据此判红。误杀正常任务
 *     比漏判一次更糟：它会让 π 学到错误的经验。
 */

import type { CriterionVerdict, JudgeEvidence, JudgeLayer } from './types.js';
import { scoreRubric } from './probe-rubric.js';

/** L2 判据标识恒定：跨会话聚合依赖它稳定。 */
export const SEMANTIC_CRITERION = 'semantic.task_completion';
const SEMANTIC_LAYER: JudgeLayer = 'L2';

/** 任一侧超过该长度即视为证据被截断：截断后算出来的覆盖率不可信。 */
export const MAX_SEMANTIC_CHARS = 8000;

/** 语义判据的输入。字段全部来自 τ（messages + tool_calls + 运行期元数据）。 */
export interface SemanticEvidence {
  /** 最后一条 role='user' && is_summary=0 的 content（超长取前 8000）。 */
  goal: string;
  /** 最后一条 role='assistant' 的 content（超长取后 8000）。 */
  finalAnswer: string;
  assistantTurns: number;
  toolSummary: { total: number; success: number; failed: number };
  finishReason: string;
  /** 截断前长度：用来识别「真的短」还是「被截了」。 */
  charCount: { goal: number; finalAnswer: number };
  /** 目标超长被截（诉求通常在开头，故保留前缀）。 */
  goalTruncated: boolean;
  /** 回答超长被截（结论通常在结尾，故保留后缀）。 */
  answerTruncated: boolean;
  /**
   * 兼容计算属性 = goalTruncated || answerTruncated。
   *
   * 注意语义：截断只是「覆盖度不可信」，**不再等于不可判**。
   * S2 覆盖率本就只观察不判红；S1/S3/S4/S7 依赖的信号（空回答、未来动作承诺、
   * 自述失败、意图词）都在被保留下来的那一侧。把截断直接判死，会让「贴了大段
   * 日志的正常任务」永远拿不到结论 —— 比误判更糟（判决变成永动机式的 inconclusive）。
   */
  truncated: boolean;
}

/**
 * 语义评估器。`assess` 必须同步、确定、无副作用 —— 这是 replay 可复算的前提。
 * kind='llm' 是留给后续深判的位置，本期不接线。
 */
export interface SemanticAssessor {
  readonly id: string;
  readonly kind: 'rules' | 'llm';
  assess(e: SemanticEvidence): CriterionVerdict;
}

/** 命中/未命中的信号 id。写进 detail，复盘时不用猜是哪条规则开的火。 */
export type SemanticSignal =
  | 'S1_empty_answer'
  | 'S2_goal_term_coverage'
  | 'S3_plan_without_action'
  | 'S4_self_reported_failure'
  | 'S5_answer_present'
  | 'S6_insufficient_evidence'
  | 'S7_explanatory_goal';

/**
 * 计划意图：只认「明确的未来动作承诺」。
 *
 * 刻意不含裸词「计划」「建议你」——「冲刺计划」「建议你先看 A 再看 B」
 * 在解释型回答里极为常见，用裸词会把问答任务判成「只说不做」（假红）。
 *
 * 动作词表必须与 `IMPERATIVE_ACTION` 保持同源：S7 只是放过「问法」，
 * S3 才是真正抓「只说不做」的那一层。若 S3 的动作词更窄，
 * 扩祈使词表也抓不住「我将为你配置 nginx」这类承诺（会漏成 pass）。
 */
const PLAN_INTENT =
  /((接下来|下面|随后)我(将|会|要|就)|我将(为你|帮你|先)?[^。；\n]{0,8}(修改|创建|生成|写入|删除|执行|运行|安装|更新|替换|修复|配置|对接|接入|联调|接上)|如需我(继续|执行|动手|操作)|要我(现在|继续)?(执行|动手)|以下是(具体)?操作步骤)/;
/** 「首先…然后」式的分步说明也算计划意图（两个词同时出现才算）。 */
const PLAN_INTENT_PAIR: [RegExp, RegExp] = [/首先/, /然后/];

/**
 * 完成证据：回答里已经写明「做成了」，就不能再按「只说不做」判红。
 * 这是 S3 的解毒剂 —— 没有它的 S3 会误杀携带计划语句的复盘式回答。
 */
const COMPLETION_EVIDENCE =
  /(已经|已)(完成|修改|创建|生成|写入|删除|执行|运行|安装|更新|替换|修复|处理)|(完成|处理)了|操作成功|执行成功|已生效/;

/**
 * 解释/咨询型目标：用户要的是说明，不是动作。
 * 对这类目标不得判「没做完」—— 一次到位的解释就是完成。
 */
const EXPLAIN_INTENT =
  /(解释|说明|介绍|区别|差异|对比|为什么|为何|原理|机制|是什么|怎么理解|如何理解|推荐|选型|排查|分析|评估|优缺点)/;

/**
 * 祈使式动作：用户明确要「你去动手」。
 *
 * 这里不能用「目标里出现动作动词」来判断：「解释如何**安装**依赖」「说明怎么**部署**」
 * 里的动作词只是被谈论的对象，解释型诉求天然会复述要解释的动作。
 * 只有带祈使语气（帮我/帮忙/请/麻烦/劳驾/给我/替我/把/需要你/顺手）的动作才是真的要动手。
 *
 * 注意：`解释/说明/介绍` 刻意不在动作词表里 —— 否则「帮忙解释一下这段代码」
 * 会被判成动作诉求，扩表就变成新的假红来源。
 */
const IMPERATIVE_ACTION =
  /(帮我|帮忙|请|麻烦|劳驾|给我|替我|把|需要你|顺手)[^。；\n]{0,12}(修改|改成|创建|新建|生成|写入|删除|移除|执行|运行|启动|部署|安装|升级|卸载|重构|修复|替换|迁移|提交|合并|打包|编译|配置|对接|接入|联调|跑一下|接上|加个|加上|去掉|调大|调小)/;

/** 以动作动词开头的 goal：省略主语的命令句，例如「修改 xx 端口为 8080」。 */
const LEADING_ACTION =
  /^\s*(修改|改成|创建|新建|生成|写入|删除|移除|执行|运行|启动|部署|安装|升级|卸载|重构|修复|替换|迁移|提交|合并|打包|编译|配置|对接|接入|联调|加个|加上|去掉|调大|调小)/;

/**
 * 第一人称动作承诺：「我将为你安装…」「接下来我会执行…」。
 *
 * 与 PLAN_INTENT 的区别：PLAN_INTENT 还包含「以下是操作步骤」这类**中立的教学式清单**
 * （解释型回答的正当形态），这里只取「我要去动手」的自指承诺 —— 那种回答即使目标是
 * 解释题，也说明模型选择了动手而不是解释，必须接受 S3 的检验。
 */
const SELF_COMMITMENT =
  /((接下来|下面|随后)我(将|会|要|就)|我将(为你|帮你|先)?[^。；\n]{0,8}(修改|创建|生成|写入|删除|执行|运行|安装|更新|替换|修复)|要我(现在|继续)?(执行|动手))/;

/**
 * 自述失败：只认自指表述（我/本助手/本次 + 做不到）。
 * 删掉了「任务失败/未完成」这类无主语句式 —— 「解释任务失败后的重试策略」
 * 是提问，不是自白。
 */
const SELF_REPORTED_FAILURE =
  /(我|本助手|本次)[^。；\n]{0,12}(无法|未能|不能|没能)(完成|做到|执行|访问|读取|写入|生成|修改)/;

/** 终止原因里「模型认为自己说完了」的三类。其它终止原因空回答不算 S1（那是 L0 的事）。 */
const S1_FINISH_REASONS = new Set(['stop', 'max_iterations', 'budget_exhausted']);

/**
 * 中文停用词表：固定字面量，不随 locale/时间变化。
 * 只去掉「几乎每句话都有、对判断完成度无信息量」的词，宁可少删不可多删。
 */
const STOPWORDS = new Set([
  '帮我', '请帮', '助我', '一下', '一个', '这个', '那个', '这些', '那些', '所有', '然后',
  '并且', '而且', '以及', '还有', '是否', '可以', '能否', '需要', '希望', '麻烦', '现在',
  '目前', '具体', '相关', '进行', '如何', '怎么', '什么', '哪些', '哪里', '为什', '如果',
  '假如', '因为', '所以', '但是', '不过', '同时', '已经', '我们', '你们', '他们', '我的',
  '你的', '的话', '一些', '有没', '没有', '是不', '不是', '就是', '这样', '那样', '怎么',
]);

/**
 * 分词：英文/数字按 `[a-z0-9_]+`，中文按 2-gram（长度 1 的中文段保留单字）。
 * 纯函数：同样输入必然得到同样词项序列。
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const token of lower.match(/[a-z0-9_]+/g) ?? []) out.push(token);
  for (const run of lower.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

/** goal 的有效词项：去停用词 + 去重 + 保持首次出现顺序（顺序无关判断，但便于复算比对）。 */
export function goalTermsOf(goal: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokenize(goal)) {
    if (STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/** 词项覆盖率：goal 词项有多少比例出现在回答里。0 表示完全答非所问。 */
export function goalTermCoverage(goalTerms: string[], finalAnswer: string): number {
  if (goalTerms.length === 0) return 0;
  const haystack = finalAnswer.toLowerCase();
  const hit = goalTerms.filter((t) => haystack.includes(t)).length;
  return round3(hit / goalTerms.length);
}

function hasPlanIntent(answer: string): boolean {
  if (PLAN_INTENT.test(answer)) return true;
  return PLAN_INTENT_PAIR[0].test(answer) && PLAN_INTENT_PAIR[1].test(answer);
}

/** 组装判决。detail 统一带上信号 id 与覆盖度，便于事后一眼看出是哪条规则开的火。 */
function verdict(
  status: 'pass' | 'fail' | 'unexec',
  signal: SemanticSignal,
  detail: string,
  score?: number,
  weightExcluded?: boolean,
): CriterionVerdict {
  return {
    layer: SEMANTIC_LAYER,
    criterion: SEMANTIC_CRITERION,
    status,
    ...(score === undefined ? {} : { score }),
    ...(weightExcluded ? { weightExcluded: true } : {}),
    detail: `signal=${signal}；${detail}`,
  };
}

/**
 * 规则评估器 v1。
 *
 * 顺序固定为 S6 → S1 → S7 → S3 → S4 → S2 → S5，但**承重的只有三处**：
 *  - S6 必须最前：没有目标文本时若先跑到 S5，会把「不知道要评什么」说成「做完了」；
 *  - S7 必须带「有回答」前置：否则空回答会被意图闸豁免成 pass（假绿）；
 *  - S7 必须带「回答没自承诺动手」前置：否则「我将为你安装…」这类只说不做
 *    会借解释型目标逃过 S3（免死金牌）。
 * 其余顺序对结论无影响（复验已证挪序是 no-op），固定它只是为了**复算稳定**：
 * replay 依赖「同一份证据必然走同一条分支」。
 */
export const ruleSemanticAssessor: SemanticAssessor = {
  id: 'rules.v1',
  kind: 'rules',
  assess(e: SemanticEvidence): CriterionVerdict {
    const goalTerms = goalTermsOf(e.goal);
    const termCoverage = goalTermCoverage(goalTerms, e.finalAnswer);
    const rubric = scoreRubric(e.goal, e.finalAnswer);
    // 目标命中评分表时用「答对几项」作完成度：步长明确（1/N），
    // 且不奖励篇幅。未命中任何评级表时退回整段词项覆盖率（通用兜底）。
    const useRubric = rubric.applicable;
    const coverage = useRubric ? rubric.score : termCoverage;
    // 截断只影响「覆盖度是否可信」，不影响其它信号：
    // S1/S3/S4/S7 依赖的线索都在被保留下来的那一侧（空回答、未来动作承诺、
    // 自述失败、目标里的意图词），因此截断不清空判决，只在 detail 里留痕。
    const truncNote =
      [e.goalTruncated ? `goalTruncated(${e.charCount.goal}字，保留前${MAX_SEMANTIC_CHARS})` : '', e.answerTruncated ? `answerTruncated(${e.charCount.finalAnswer}字，保留后${MAX_SEMANTIC_CHARS})` : '']
        .filter(Boolean)
        .join('、');
    const coverageNote = useRubric
      ? `rubric=${rubric.rubricId} 得分 ${coverage}（${rubric.hits}/${rubric.count} 项${rubric.missing.length > 0 ? `，漏：${rubric.missing.map((m) => `${m.id}(${m.label})`).join('、')}` : ''}）；goal_term_coverage=${termCoverage}（词项 ${goalTerms.length} 个）${truncNote ? `；${truncNote}` : ''}`
      : `goal_term_coverage=${coverage}（词项 ${goalTerms.length} 个）${truncNote ? `；${truncNote}` : ''}`;
    // 被截断时覆盖度不可信 → 不写 score（写 0 会被下游当"确定没覆盖"）。
    const coverageScore = e.truncated ? undefined : coverage;

    // ── S6 证据闸：没有对照物就不出结论 ─────────────────────────────────
    // 只有「真的没有目标文本」才 unexec。截断不缺对照物，只是对照物不完整，
    // 那属于覆盖度问题（S2 只观察不判红），不该把整条判据判死。
    if (e.goal.trim() === '') {
      return verdict('unexec', 'S6_insufficient_evidence', `本轮无用户目标文本，语义判据无对照物；${coverageNote}`);
    }

    // ── S1 空回答：只有「模型认为自己说完了」时才判红 ──────────────────
    // 必须早于 S7：空回答在任何目标类型下都不是「完成」，先让 S7 豁免会
    // 把「解释 X」+ 空回答判成 pass（新的假绿）。
    const answer = e.finalAnswer;
    const trimmed = answer.trim();

    if (trimmed === '' && S1_FINISH_REASONS.has(e.finishReason)) {
      return verdict('fail', 'S1_empty_answer', `终止原因 ${e.finishReason} 但最终回答为空；${coverageNote}`);
    }

    // ── S7 目标意图闸：解释/咨询型目标不判完成度 ─────────────────────────
    // 判「没做完」需要先成立一个前提：用户要的是一次动作。解释型目标不满足它，
    // 硬判 fail 会误杀正常的问答任务，并污染经验有效性的分母。
    // 两个前置：
    //  1. 确实给了回答（没有回答就没有「解释」，不能拿 S7 当豁免券）；
    //  2. 目标里没有**祈使式**动作诉求 —— 「解释如何安装」是问法，
    //     「说明一下，然后帮我安装」才是真的要动手（后者不许豁免）；
    //  3. 回答本身不是「我这就动手」的承诺 —— 解释型回答可以给步骤清单，
    //     但一旦它自己承诺了动作却没动作，就必须交给 S3 判（S7 不是免死金牌）。
    if (
      trimmed !== '' &&
      EXPLAIN_INTENT.test(e.goal) &&
      !IMPERATIVE_ACTION.test(e.goal) &&
      !LEADING_ACTION.test(e.goal) &&
      !SELF_COMMITMENT.test(answer)
    ) {
      return verdict(
        'pass',
        'S7_explanatory_goal',
        `目标为解释/咨询型，语义层不判完成度，只记录词项覆盖 ${coverage}；${coverageNote}`,
        // 无词项时给中性 0.5（不是 0，避免被读成"完全没覆盖"）；截断时不给分。
        e.truncated ? undefined : goalTerms.length === 0 ? 0.5 : coverage,
        // 「不适用」不该被计成 1.0，否则解释型任务的 run.score 会虚高。
        true,
      );
    }

    // ── S3 只说不做：计划承诺 + 单轮 + 零工具 + 正常结束 + 无完成证据 ────
    if (
      hasPlanIntent(answer) &&
      e.assistantTurns === 1 &&
      e.toolSummary.total === 0 &&
      e.finishReason === 'stop' &&
      !COMPLETION_EVIDENCE.test(answer)
    ) {
      return verdict(
        'fail',
        'S3_plan_without_action',
        `回答只描述了计划（assistantTurns=1、工具 0 次、finish=stop、无完成证据）却没有任何动作；${coverageNote}`,
      );
    }

    // ── S4 自述失败（加严版）：自认没做成 且 没有任何工具成功 ────────────
    if (SELF_REPORTED_FAILURE.test(answer) && e.toolSummary.success === 0) {
      return verdict(
        'fail',
        'S4_self_reported_failure',
        `回答自述未完成且本轮无成功工具调用（成功 ${e.toolSummary.success}/${e.toolSummary.total}）；${coverageNote}`,
      );
    }

    // 空回答但终止原因不在 S1 集合（如 aborted / circuit_open / 未知）：
    // L0 已经对终止性开过火，这里不重复判红，也绝不因此给出绿灯。
    if (trimmed === '') {
      return verdict(
        'unexec',
        'S6_insufficient_evidence',
        `终止原因 ${e.finishReason} 下回答为空，语义层不另作判断（交由 L0 定论）；${coverageNote}`,
      );
    }

    // ── S2 词项覆盖率：降级为 abstain —— 只观察，不判红 ─────────────────
    // 覆盖率低可能只是「换了说法」或「回答比目标更概括」，单凭它判红会误杀。
    if (goalTerms.length >= 3 && coverage < 0.15) {
      return verdict(
        'pass',
        'S2_goal_term_coverage',
        `${coverageNote} 偏低，但词项覆盖率不足以证明未完成（低覆盖 ≠ 未完成），不判红`,
        coverageScore,
      );
    }

    // ── S5 有回答且无红信号：这是唯一"绿灯"的来源 ──────────────────────
    return verdict(
      'pass',
      'S5_answer_present',
      `最终回答非空（${e.charCount.finalAnswer} 字符，${e.assistantTurns} 轮）；${coverageNote}`,
      coverageScore,
    );
  },
};

/**
 * 从原始材料装配 SemanticEvidence。截断在此处一次完成，因此
 * 「记录下来的证据」与「重算用的证据」永远是同一份文本。
 *
 * 两侧保留的位置刻意不同：
 *  - goal 保留**前** 8000：用户要什么通常写在开头（后面多是粘贴的日志/代码）；
 *  - finalAnswer 保留**后** 8000：结论通常写在结尾（前面多是过程叙述）。
 * 取反了就等于把唯一有用的部分裁掉。
 */
export function buildSemanticEvidence(input: {
  goal: string;
  finalAnswer: string;
  assistantTurns: number;
  toolCalls: Array<{ status: string }>;
  finishReason: string;
}): SemanticEvidence {
  const goalChars = input.goal.length;
  const answerChars = input.finalAnswer.length;
  const goalTruncated = goalChars > MAX_SEMANTIC_CHARS;
  const answerTruncated = answerChars > MAX_SEMANTIC_CHARS;
  const success = input.toolCalls.filter((c) => c.status === 'success').length;
  const failed = input.toolCalls.filter((c) => c.status === 'failed').length;
  return {
    goal: goalTruncated ? input.goal.slice(0, MAX_SEMANTIC_CHARS) : input.goal,
    finalAnswer: answerTruncated ? input.finalAnswer.slice(-MAX_SEMANTIC_CHARS) : input.finalAnswer,
    assistantTurns: input.assistantTurns,
    toolSummary: { total: input.toolCalls.length, success, failed },
    finishReason: input.finishReason,
    charCount: { goal: goalChars, finalAnswer: answerChars },
    goalTruncated,
    answerTruncated,
    truncated: goalTruncated || answerTruncated,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
