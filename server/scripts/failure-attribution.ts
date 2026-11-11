/**
 * failure-attribution.ts — 失败归因的分层。
 *
 * ── 它解决什么问题 ────────────────────────────────────────
 * 在此之前，账本里只有 `verdict: "failed"`。这一句话把七种完全不同的失败混成一件：
 *
 *   · 服务没起来（ECONNREFUSED）        —— Agent 完全无关
 *   · token 预算在探索阶段就耗尽        —— 任务粒度问题
 *   · 有预算但一次工具都不调（只说不做）—— 模型行为
 *   · 任务书自相矛盾，它卡在「该信哪句」—— 出题人的错
 *   · 实现写对了但没注册进产品          —— 真缺陷，但它看不见
 *   · 代码本身写错                      —— 真正该学的
 *   · 判据自己写错（假红）              —— 尺子的错
 *
 * 混在一起的代价是**学不到**：账本只能说「这题失败 3 次」，说不出「该换模型、
 * 该拆题、还是该修判据」。于是循环会重复派一个不可能完成的任务，
 * 而真正值得沉淀的信号被「失败」两个字抹平。
 *
 * ── 分层的判定原则 ────────────────────────────────────────
 * 1. **只读机械信号**：进程退出码、run_report 里的计数、围栏四道结论的布尔值、
 *    诊断文本里的固定错误串。不做语义推断，不猜模型意图。
 * 2. **从外到内判定，先命中先归**：环境 > 预算 > 行为 > 规格 > 集成 > 实现 > 判据。
 *    因为「服务没起来」会伪装成「实现全错」——判据在没连上的服务上当然全红。
 * 3. **只有 integration / implementation 计入 Agent 的能力账**。
 *    其余五层要么不是它造成的，要么它根本看不见；记成它的失败，学习信号就被污染。
 * 4. **judge 层必须停机**：尺子错了还继续跑，后续每一轮都是在给错尺子打工。
 */

/** 七个层。顺序即判定优先级（从外到内）。 */
export type FailureLayer =
  | 'infra' //        L0 环境：服务/端口/沙箱根 —— 调度器的责任
  | 'budget' //       L1 资源：token/迭代/墙钟被掐断 —— 任务粒度或配置
  | 'behavior' //     L2 行为：有预算却不落盘（只说不做、空转）
  | 'spec' //         L3 规格：任务书矛盾/信息不足，它在探索或纠结
  | 'integration' //  L4 集成：写出来了但没接进产品（注册、自动捕获、既有门禁）
  | 'implementation' // L5 实现：代码本身错 —— 唯一「它该学会」的层
  | 'judge'; //       L6 判据：尺子自己错（假红）—— 出题人的责任，必须停机

export type FailureOwner = 'scheduler' | 'author' | 'model' | 'agent';

export type NextAction =
  | 'retry_same' // 环境问题修好后重试，不消耗尝试次数
  | 'retry_with_diagnosis' // 带诊断重派（实现层）
  | 'regenerate_taskbook' // 重新出题（规格层）
  | 'split_task' // 拆成更小的步（资源/行为层）
  | 'switch_model' // 换模型（行为层）
  | 'halt_manual'; // 停机等人工（判据层、环境层修不好时）

/** 一次派单 + 一次围栏的可观测事实。归因只吃这个结构，不吃自然语言。 */
export interface AttributionInput {
  taskId: string;
  attempt: number;
  maxAttempts: number;
  /** 派单进程：是否正常退出 + 原始输出（含 SSE 与 run_report）。 */
  dispatch: { exitOk: boolean; output: string };
  /** 失败诊断文本（编译器报错、断言差异、围栏结论）。 */
  diagnosis: string;
  /** 围栏四道结论。缺省视为「没跑到那一步」。 */
  fence: {
    reached: boolean; //         围栏是否跑完（false = 在它之前就挂了）
    targetChanged: boolean; //   靶子内容真的变了
    typeOk: boolean; //          tsc --noEmit
    judgeOk: boolean; //         判据
    fullOk: boolean; //          全量回归
    protectedIntact: boolean; // 受保护路径零改动
    judgeTampered: boolean; //   判据文件被改写
  };
  /** 派单前服务健康检查是否通过（循环自己做的）。 */
  serviceHealthy: boolean;
}

export interface Attribution {
  layer: FailureLayer;
  /** 机械可读的原因码，直接进账本，可聚合。 */
  code: string;
  /** 判定依据：命中的原文片段，便于人工复核「它凭什么这么归」。 */
  evidence: string[];
  owner: FailureOwner;
  /** 是否计入 Agent 的能力账（只有 L4/L5 为 true）。 */
  countsAgainstAgent: boolean;
  nextAction: NextAction;
  /** 给下一轮的话。**不是**诊断本身：诊断说「哪错了」，这里说「谁该做什么」。 */
  note: string;
}

/** 从 run_report 里抠机械计数。缺失一律返回 null，绝不猜默认值。 */
interface RunFacts {
  outcome: string | null;
  finishReason: string | null;
  toolCallCount: number | null;
  fileChangeCount: number | null;
  promptTokens: number | null;
  tokenBudget: number | null;
}

function readRunFacts(output: string): RunFacts {
  const last = <T>(re: RegExp): T | null => {
    const hits = [...output.matchAll(re)];
    if (hits.length === 0) return null;
    return (hits[hits.length - 1]?.[1] ?? null) as T | null;
  };
  const num = (re: RegExp): number | null => {
    const v = last<string>(re);
    return v === null ? null : Number(v);
  };
  return {
    outcome: last<string>(/"outcome":"([^"]+)"/g),
    finishReason: last<string>(/"finishReason":"([^"]+)"/g),
    toolCallCount: num(/"toolCallCount":(\d+)/g),
    fileChangeCount: num(/"fileChangeCount":(\d+)/g),
    promptTokens: num(/"promptTokens":(\d+)/g),
    tokenBudget: num(/"tokenBudget":(\d+)/g),
  };
}

/** 工具调用的名字序列，用来判断「它在探索还是在实现」。 */
function toolNameSequence(output: string): string[] {
  return [...output.matchAll(/event: tool_call\ndata: \{"callId":"[^"]*","name":"([^"]+)"/g)].map((m) => m[1] ?? '');
}

const READ_TOOLS = new Set(['fs.read', 'fs.list']);

/**
 * 归因主函数。纯函数：同样的输入永远同样的输出（可单测、可回放历史现场）。
 */
export function attributeFailure(input: AttributionInput): Attribution {
  const facts = readRunFacts(input.dispatch.output);
  const tools = toolNameSequence(input.dispatch.output);
  const readCalls = tools.filter((t) => READ_TOOLS.has(t)).length;
  const writeCalls = tools.filter((t) => t === 'fs.write').length;

  // ── L6 判据层：先判它，因为判据被改写会让后面所有结论失去意义 ──────────
  if (input.fence.judgeTampered) {
    return {
      layer: 'judge',
      code: 'JUDGE_TAMPERED',
      evidence: ['围栏：判据文件指纹变化'],
      owner: 'author',
      countsAgainstAgent: false,
      nextAction: 'halt_manual',
      note: '判据被改写，本次结果作废。需要人工确认改动来源后重打基线。',
    };
  }
  if (input.dispatch.exitOk && /Cannot find module .*tests\//.test(input.diagnosis)) {
    // 判据自身 import 不到目标文件时，报错文本是「Cannot find module」，
    // 和「实现没写」长得一样；区别在于路径指向 tests/ 下的判据自己。
    return {
      layer: 'judge',
      code: 'JUDGE_SELF_IMPORT',
      evidence: ['诊断里出现 Cannot find module，路径指向 tests/'],
      owner: 'author',
      countsAgainstAgent: false,
      nextAction: 'halt_manual',
      note: '判据自身的 import 路径可能写错，先人工确认判据能独立跑通。',
    };
  }

  // ── L0 环境层：连不上服务时，后面所有红都是假的 ────────────────────────
  const infraSig =
    /ECONNREFUSED|EADDRINUSE|ECONNRESET|socket hang up|服务 .* 内未就绪|沙箱根指错/.exec(input.dispatch.output) ??
    // 上游返回空轮（无正文/无推理/无工具调用/0 token）。这不是模型不作为——
    // 它在 run_report 里和「只说不做」长得一样，所以必须靠错误码区分。
    /UPSTREAM_EMPTY|上游返回空响应/.exec(`${input.dispatch.output}\n${input.diagnosis}`);
  if (!input.serviceHealthy || infraSig) {
    return {
      layer: 'infra',
      code: infraSig ? `INFRA_${infraSig[0].replace(/\W+/g, '_').toUpperCase()}` : 'INFRA_UNHEALTHY',
      evidence: infraSig ? [infraSig[0]] : ['派单前服务健康检查未通过'],
      owner: 'scheduler',
      countsAgainstAgent: false,
      nextAction: 'retry_same',
      note: 'Agent 没被真正派单。修好服务后重试，这次不计入尝试次数。',
    };
  }

  // ── L1 资源层：预算/迭代/墙钟掐断 —— 任务没走完，不是做错了 ────────────
  // 「输出被 max_tokens 截断」也算这一层：它和预算耗尽同因（输出空间不够），
  // 只是发生在单轮而不是整个任务。之前截断被记成 'stop'，于是「写了一半」和
  // 「写完收工」在账本里没有区别。
  const truncated = /max_tokens 上限被截断|finish_reason=length/.test(`${input.dispatch.output}\n${input.diagnosis}`);
  if (truncated || facts.outcome === 'budget_exhausted' || facts.finishReason === 'max_iterations') {
    const ratio =
      facts.promptTokens !== null && facts.tokenBudget ? `（${facts.promptTokens}/${facts.tokenBudget} token）` : '';
    const code = truncated
      ? 'OUTPUT_TRUNCATED'
      : facts.outcome === 'budget_exhausted'
        ? 'BUDGET_EXHAUSTED'
        : 'MAX_ITERATIONS';
    return {
      layer: 'budget',
      code,
      evidence: [
        truncated
          ? '单轮输出达到 max_tokens 上限（finish_reason=length）'
          : `outcome=${String(facts.outcome)} finishReason=${String(facts.finishReason)} ${ratio}`.trim(),
      ],
      owner: 'author',
      countsAgainstAgent: false,
      nextAction: 'split_task',
      note:
        code === 'OUTPUT_TRUNCATED'
          ? '它想一次写完的篇幅超过了单轮上限，结果写到一半就被切断。把这一步拆小，或让它分两次写。'
          : '任务在被判错之前就被掐断。要么拆成更小的步，要么放开预算；不要记成模型失败。',
    };
  }

  // ── L2 行为层：有预算却不落盘 ─────────────────────────────────────────
  if (facts.toolCallCount === 0 && writeCalls === 0) {
    return {
      layer: 'behavior',
      code: 'NO_TOOL_CALL',
      evidence: [`toolCallCount=0，finishReason=${String(facts.finishReason)}`],
      owner: 'model',
      countsAgainstAgent: false,
      nextAction: 'switch_model',
      note: '它只输出了文字，一次工具都没调。这不是「不会做」，是行为模式问题：换模型或压缩任务书。',
    };
  }

  // ── L3 规格层：全程在读、或在同一批文件上打转 ─────────────────────────
  // 阈值取 0.7：读调用占比过七成且没有任何写入，说明它在「研究」而不是「做」。
  // 这一层和 L2 的区别是「动了手但方向是探索」，与「完全不动手」处置不同：
  // L2 换模型，L3 改题（它可能在正确地研究一份写错了的任务书）。
  if (tools.length > 0 && writeCalls === 0 && readCalls / tools.length >= 0.7) {
    return {
      layer: 'spec',
      code: 'EXPLORATION_ONLY',
      evidence: [`${readCalls}/${tools.length} 次调用是读，0 次写入`],
      owner: 'author',
      countsAgainstAgent: false,
      nextAction: 'regenerate_taskbook',
      note: '它在研究而不是在写。先检查任务书是否自相矛盾、是否缺关键信息，再考虑加预算。',
    };
  }

  // ── L4 集成层：判据绿但产品不认 ──────────────────────────────────────
  if (input.fence.reached && input.fence.judgeOk && !input.fence.fullOk) {
    return {
      layer: 'integration',
      code: 'FULL_SUITE_RED',
      evidence: ['判据通过，全量回归失败'],
      owner: 'agent',
      countsAgainstAgent: true,
      nextAction: 'retry_with_diagnosis',
      note: '单题判据过了，但踩坏了既有行为（新增工具没登记、既有门禁不认它）。把回归失败的具体用例喂回去。',
    };
  }
  if (input.fence.reached && input.fence.judgeOk && !input.fence.typeOk) {
    return {
      layer: 'integration',
      code: 'TYPECHECK_RED',
      evidence: ['判据通过，tsc --noEmit 失败'],
      owner: 'agent',
      countsAgainstAgent: true,
      nextAction: 'retry_with_diagnosis',
      note: '行为对了、类型不过 —— 测试能过但构建会挂。把编译器原文喂回去。',
    };
  }

  // ── L5 实现层：兜底，也是真正该学的那一层 ────────────────────────────
  if (input.fence.reached && !input.fence.targetChanged) {
    return {
      layer: 'implementation',
      code: 'TARGET_UNTOUCHED',
      evidence: ['围栏：靶子内容未变，但本轮有工具调用'],
      owner: 'agent',
      countsAgainstAgent: true,
      nextAction: 'retry_with_diagnosis',
      note: '它动了别的文件或改动没落盘。把「靶子一个字节都没变」这个事实明确告诉它。',
    };
  }
  return {
    layer: 'implementation',
    code: 'BEHAVIOR_WRONG',
    evidence: ['判据未通过，靶子已改动'],
    owner: 'agent',
    countsAgainstAgent: true,
    nextAction: input.attempt >= input.maxAttempts ? 'split_task' : 'retry_with_diagnosis',
    note: '这是唯一该记在 Agent 账上的层：代码写出来了，行为不对。诊断里已有断言差异。',
  };
}

/** 账本行要追加的字段。集中在这里，保证账本消费者只认一种形状。 */
export interface LedgerAttribution
  extends Pick<Attribution, 'layer' | 'code' | 'owner' | 'countsAgainstAgent' | 'nextAction'> {
  taskId: string;
  attempt: number;
}

export function toLedgerFields(a: Attribution, taskId: string, attempt: number): LedgerAttribution {
  return {
    taskId,
    attempt,
    layer: a.layer,
    code: a.code,
    owner: a.owner,
    countsAgainstAgent: a.countsAgainstAgent,
    nextAction: a.nextAction,
  };
}

/** 层的中文名与一句话职责，给统计输出用（避免各处再抄一份映射）。 */
export const LAYER_META: Record<FailureLayer, { label: string; owner: FailureOwner; hint: string }> = {
  infra: { label: '环境', owner: 'scheduler', hint: '服务/端口/沙箱根 —— 修循环，不是修 Agent' },
  budget: { label: '资源', owner: 'author', hint: '预算/迭代/墙钟掐断 —— 拆题或放开预算' },
  behavior: { label: '行为', owner: 'model', hint: '有预算不落盘 —— 换模型、改指令' },
  spec: { label: '规格', owner: 'author', hint: '任务书矛盾或信息不足 —— 重写任务书' },
  integration: { label: '集成', owner: 'agent', hint: '写出来了但没接进产品 —— 喂回归用例' },
  implementation: { label: '实现', owner: 'agent', hint: '代码行为错 —— 唯一该学的层' },
  judge: { label: '判据', owner: 'author', hint: '尺子错（假红）—— 停机修判据' },
};
