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
  | 'skip_task' // 这题在 Agent 能力范围内无解（尺子/夹具坏），本轮跳过，不烧墙钟
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
    /**
     * 全量回归是否**真的跑过**。缺省 true（老调用方语义不变）。
     *
     * 必须与 fullOk 分开：围栏在「类型检查红」时会**跳过**全量回归，
     * 那时 fullOk 只能取 false，于是「没跑」被读成「跑了且红」——
     * 实测这直接把一次 TS2322 误判成「踩坏既有行为」，喂了三轮错方向。
     */
    fullRan?: boolean;
    /** 类型检查是否真的跑过（判据红时会被跳过）。缺省 true。 */
    typeRan?: boolean;
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
 * 从诊断里挑出**最该被引用的一句话**，塞进 note。
 *
 * 为什么要做这件事：note 原来是按层写死的模板句（「把编译器原文喂回去」），
 * 而诊断原文只在旁边的文件里。派单只把 note 加上诊断一起送，模型往往照着
 * 上一轮的层名去猜，猜错方向。实测第 2/3 轮收到的是
 * 「新增工具没登记」，而真实错误是 `kind: "precondition_failed"` 不是合法枚举——
 * 两句话的修法完全不同。note 里带上真实那一行，反馈才叫「明确具体」。
 */
export function pickErrorLine(diagnosis: string): string | null {
  const clip = (s: string): string => (s.length > 220 ? `${s.slice(0, 220)}…` : s);
  const lines = diagnosis
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // 编译器错误优先：语法/类型不合法时判据一条都跑不起来，其它结论都没意义
  const ts = lines.find((l) => /error TS\d{4}/.test(l));
  if (ts) return clip(ts);

  // 判据诊断的固定形状是「· 用例名」下一行「→ 差异」。
  // 两个一起给才有用：只给用例名不知道差在哪，只给差异不知道是哪条断言。
  // 原先只匹配 toBe/toEqual/toContain，遇到 `to match /line\s*\d+/i` 就落到
  // 围栏那句「FAIL 判据未通过：xxx」上 —— 反馈退化成「这题没过」，等于没说。
  const arrowAt = lines.findIndex((l) => /^→/.test(l));
  if (arrowAt >= 0) {
    const diff = (lines[arrowAt] ?? '').replace(/^→\s*/, '');
    const name = [...lines.slice(0, arrowAt)].reverse().find((l) => /^·/.test(l));
    const label = name ? `${name.replace(/^·\s*/, '')}｜` : '';
    return clip(`${label}${diff}`);
  }

  const assertion = lines.find((l) => /AssertionError|expected .+ to (be|equal|contain|match|throw|have)/.test(l));
  if (assertion) return clip(assertion);
  const fail = lines.find((l) => /^FAIL\s/.test(l));
  return fail ? clip(fail) : null;
}

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

  // ── L0a 调度器缺件：题入队了，但派单脚本没有对应任务书 ──────────────────
  //
  // 实测：auto-adopt 采纳了新题，而 buildXxxTask 是一张静态表，派单脚本 3 秒退出报
  // 「未知题目」，三轮全空转。当时归因判成 implementation/TARGET_UNTOUCHED 并计入 Agent——
  // 可它连任务书都没收到，这不是能力缺口，是调度链断了。
  // 这类失败重试没有意义（重派还是同一句报错），必须停机补任务书。
  const taskbookSig = /未知题目|UNKNOWN_TASK|TASKBOOK_MISSING/.exec(input.dispatch.output);
  if (taskbookSig) {
    return {
      layer: 'infra',
      code: 'TASKBOOK_MISSING',
      evidence: [taskbookSig[0]],
      owner: 'scheduler',
      countsAgainstAgent: false,
      nextAction: 'halt_manual',
      note: '题已入队但派单脚本没有任务书，Agent 根本没被派单。停机补任务书，不要重试、不要记成它的失败。',
    };
  }

  // ── L0a1 LLM 上游额度耗尽 ──────────────────────────────────────────────
  //
  // 与「连不上」不同：端点通、/models 200，但 chat 返回 429 +
  // "Daily usage limit exceeded ... resets at ..."。这是账户级日限额，
  // 换模型也没用（同一账号共享），重派只会一直撞同一堵墙。
  // 必须单独归类：否则它被当成一次空转，落到 Agent 的实现层账上。
  const quotaSig =
    /Daily usage limit exceeded|rate_limit_exceeded|insufficient_quota|quota.{0,20}exceed|额度耗尽|UPSTREAM_QUOTA_EXCEEDED/i.exec(
      `${input.dispatch.output}\n${input.diagnosis}`,
    );
  if (quotaSig) {
    return {
      layer: 'infra',
      code: 'UPSTREAM_QUOTA_EXCEEDED',
      evidence: [quotaSig[0]],
      owner: 'scheduler',
      countsAgainstAgent: false,
      nextAction: 'halt_manual',
      note: '上游账户额度耗尽，重置前重派无意义。停机等重置；换模型无效（同一账号共享限额）。',
    };
  }

  // ── L0a2 LLM 上游不可达 ────────────────────────────────────────────────
  //
  // 与「本地服务没起来」是两回事：8099 的 health 可以是 ok，服务也正常派单，
  // 但它转发 LLM 请求时连不上 8787 —— 表现为 fetch failed / CONNECT_TIMEOUT，
  // run_report 里既没工具调用也没正文，和「模型只说不做」长得几乎一样。
  // 实测 2026-11-12：端点持续 UND_ERR_CONNECT_TIMEOUT，若不做这一层，
  // 三轮空转会被记成 implementation/TARGET_UNTOUCHED 并计入 Agent 能力账。
  //
  // 重派没有意义（还是同一句超时），必须停机恢复上游。
  const upstreamSig =
    /UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_CONNECT|fetch failed|ETIMEDOUT|ECONNABORTED|CONNECT_TIMEOUT|connect timeout|UPSTREAM_UNREACHABLE|上游不可达/i.exec(
      `${input.dispatch.output}\n${input.diagnosis}`,
    );
  if (upstreamSig) {
    return {
      layer: 'infra',
      code: 'UPSTREAM_UNREACHABLE',
      evidence: [upstreamSig[0]],
      owner: 'scheduler',
      countsAgainstAgent: false,
      nextAction: 'halt_manual',
      note: 'LLM 上游连不上（本地服务健康但转发失败）。重派还是同一句超时，停机恢复上游；不计入 Agent。',
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

  // ── L6b 判据层：判据自己跑不动（夹具被安全策略拦住 / 依赖缺失） ─────────
  //
  // 实测 2026-11-12（test-run / iteration-view / exec-partial-on-timeout 三题）：
  // 判据在夹具里一次删 50 个文件，被沙箱的 safe-delete 策略拦下，
  // 于是每条断言都收到 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`。
  // 归因当时判成 implementation/BEHAVIOR_WRONG 并计入 Agent，三题共烧掉
  // 8 次派单、约 45 分钟墙钟 —— 但它撞的是一堵 Agent 无权拆的墙。
  // 判据跑不动 ≠ 代码写错；这类必须绕开（skip_task），不许重派。
  const fixtureBlockedHits = [
    ...`${input.diagnosis}\n${input.dispatch.output}`.matchAll(/SAFE_DELETE_BULK_CONFIRM_REQUIRED|\[safe-delete\]/gi),
  ];
  // 阈值取 3：合法行为只会在个别断言上出现一次（工具本来就该拒批量删），
  // 而夹具被拦是**每条**断言都收到同一句策略拒绝。只用 1 次判据会洗白真缺陷。
  if (fixtureBlockedHits.length >= 3) {
    return {
      layer: 'judge',
      code: 'JUDGE_FIXTURE_BLOCKED',
      evidence: [`安全策略拒绝出现 ${fixtureBlockedHits.length} 次（每条断言都收到，而非个别行为）`],
      owner: 'author',
      countsAgainstAgent: false,
      nextAction: 'skip_task',
      note:
        '判据的夹具被沙箱安全策略（safe-delete 批量确认）拦住，断言收到的是策略拒绝而不是被测行为。' +
        '这是尺子跑不动，不是代码错：把夹具改成 mkdtemp 独立目录 + 每次只删少量文件，在人工修好前跳过本题，别重派。',
    };
  }

  // ── L4 集成层：判据绿但产品不认 ──────────────────────────────────────
  //
  // 顺序至关重要：**类型检查先于全量回归**。
  // 因为围栏在类型红时会跳过全量回归（跑它只是花五分钟确认一件已知的事），
  // 而 fullOk 拿不到 PASS 行就只能是 false —— 于是「没跑」伪装成「跑了且红」。
  // 实测代价：一次 TS2322（kind 写成了非法枚举值）被归成 FULL_SUITE_RED，
  // 反馈说「把回归失败用例喂回去」，模型照着去查回归，两轮都在错方向上改。
  if (input.fence.reached && input.fence.judgeOk && input.fence.typeRan !== false && !input.fence.typeOk) {
    const line = pickErrorLine(input.diagnosis);
    return {
      layer: 'integration',
      code: 'TYPECHECK_RED',
      evidence: ['判据通过，tsc --noEmit 失败', ...(line ? [line] : [])],
      owner: 'agent',
      countsAgainstAgent: true,
      nextAction: 'retry_with_diagnosis',
      note:
        '行为对了、类型不过 —— 测试能过但构建会挂。编译器原文' +
        (line ? `：${line}` : '见诊断第 1 段') +
        '。只改到类型合法为止，不要为了绕开类型错误去改判据或删断言。',
    };
  }
  if (input.fence.reached && input.fence.judgeOk && input.fence.fullRan !== false && !input.fence.fullOk) {
    const line = pickErrorLine(input.diagnosis);
    return {
      layer: 'integration',
      code: 'FULL_SUITE_RED',
      evidence: ['判据通过，全量回归失败', ...(line ? [line] : [])],
      owner: 'agent',
      countsAgainstAgent: true,
      nextAction: 'retry_with_diagnosis',
      note:
        '单题判据过了，但踩坏了既有行为（新增工具没登记、既有门禁不认它）。回归失败用例' +
        (line ? `：${line}` : '见诊断') +
        '。先让这条恢复，再谈本题。',
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
      note: '靶子文件一个字节都没变（你动的可能是别的文件，或改动没落盘）。这一轮必须把 diff 落在靶子文件里，描述计划不算完成。',
    };
  }
  const behaviorLine = pickErrorLine(input.diagnosis);
  return {
    layer: 'implementation',
    code: 'BEHAVIOR_WRONG',
    evidence: ['判据未通过，靶子已改动', ...(behaviorLine ? [behaviorLine] : [])],
    owner: 'agent',
    countsAgainstAgent: true,
    nextAction: input.attempt >= input.maxAttempts ? 'split_task' : 'retry_with_diagnosis',
    note:
      '代码写出来了，行为不对。第一条断言差异' +
      (behaviorLine ? `：${behaviorLine}` : '见诊断') +
      '。改实现去满足它，不要改判据。',
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
