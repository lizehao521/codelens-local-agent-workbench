/**
 * 判据塔（Judge）的类型契约（强化内核宣言第 3 节）。
 *
 * 设计要点：
 *  - `unexec` 是一等状态，不是「没填」。没有证据时诚实的判决是「未执行」，
 *    既不是绿灯也不是红灯（C4：UNEXEC ≠ PASS）。
 *  - 每条判据都必须能被破坏夹具打红，否则它不是判据，是装饰（C3）。
 *  - 判决 r 必须能指回它读过的证据 τ（evidenceRef），否则结论不可追溯。
 *
 * v2 追加「分层覆盖率」：覆盖率的分母必须只算**本进程真正有能力判定**的层。
 * 旧口径把恒不执行的 L2/L3 也塞进分母，于是 5/8=0.625 就能过 0.6 的门槛 ——
 * 「什么都没测到」被算成了「测得差不多了」。available 是能力声明，不是结果。
 */

/** 判据塔分层：低层不能替高层签字，高层不能替低层免责。 */
export type JudgeLayer = 'L0' | 'L1' | 'L2' | 'L3';

/** 三态判决。unexec 表示「该判据本次未能执行」，不计入通过也不计入失败。 */
export type VerdictStatus = 'pass' | 'fail' | 'unexec';

/** 一次判决的总体结论。inconclusive = 无失败但覆盖率不足，即「未验证」。 */
export type RunVerdict = 'pass' | 'fail' | 'inconclusive';

export interface CriterionVerdict {
  layer: JudgeLayer;
  /** 判据标识，如 `tool.success_rate`。稳定字符串，用于跨会话聚合。 */
  criterion: string;
  status: VerdictStatus;
  /** 0–1 的连续得分，仅在该判据本身是量化判据时有值。 */
  score?: number;
  /**
   * 该判据「不适用」而不是「通过了」：仍计入 coverage（它确实产出了结论），
   * 但不参与 run.score 的均值 —— 否则「语义层不对解释型目标判完成度」这种
   * 不适用结论会被算成 1.0，把解释型任务的分数抬高。
   */
  weightExcluded?: boolean;
  /** 人类可读的判定理由，写清「为什么是这个状态」。 */
  detail?: string;
}

/** 判据读取的证据快照 —— 从 τ（tool_calls / approvals / 运行期元数据）抽取。 */
export interface JudgeEvidence {
  sessionId: string;
  /** 本次 Agent 运行的终止原因。 */
  finishReason: string;
  iteration: number;
  tokenBudget: number;
  usage: { promptTokens: number; completionTokens: number };
  /** τ：本轮全部工具调用（只取判据需要的字段，避免把整行塞进判决）。 */
  toolCalls: Array<{
    status: string;
    display_name: string;
    error_kind?: string | null;
    /**
     * 命令执行类工具的真实退出码（sys.exec）。undefined = 该工具没有退出码这个概念。
     * `tool.success_rate` 用它区分「命令跑完了」和「做成了事」：
     * success + exitCode!==0 必须算失败，否则「能跑」会被统计成「正确」。
     */
    exit_code?: number | null;
  }>;
  /** τ：本轮全部审批。 */
  approvals: Array<{ status: string; decision: string | null }>;
  /** 运行期信号：本轮是否触发过熔断。 */
  circuitOpened: boolean;
}

/**
 * 某层「为什么不可用」。三种原因要分开记，否则复盘时无法区分
 * 「没接线」和「上游没跑」——前者是工程欠账，后者是运行时事实。
 */
export type LayerUnavailableReason = 'assessor_not_wired' | 'depends_on_unavailable' | 'not_declared';

/** 一层的可用性声明。available 说的是能力，不是本次结果。 */
export interface LayerProfile {
  layer: JudgeLayer;
  /** 本进程是否有能力产出非 unexec 判决。 */
  available: boolean;
  /** 未执行时不得判 pass。required 层留空必须判 inconclusive。 */
  required: boolean;
  /** available=true 时必须为 null（不可用层才需要解释）。 */
  reason: LayerUnavailableReason | null;
  detail?: string;
}

/** 必需层留下的缺口。与 reasons 分开：这是「哪一层、哪种缺口」。 */
export interface LayerGap {
  layer: JudgeLayer;
  reason: 'unavailable' | 'unexecuted' | 'below_layer_min';
}

/**
 * run 级结论（v2）。
 *
 * 双口径并存是刻意的：
 *  - coverage 是主口径，分母只含 available 层 —— 判决据此定档；
 *  - towerCoverage 是全塔口径，仅用于展示「整座塔今天跑了几成」，
 *    绝不参与定档，否则 A 缺陷（层内判据数稀释分母）会立刻复活。
 */
export interface JudgeSummary {
  verdict: RunVerdict;
  score: number;
  coverage: number;
  executed: number;
  total: number;
  towerCoverage: number;
  towerExecuted: number;
  towerTotal: number;
  /** 不可用层为 null（未知），不是 0（全红）—— 两者含义完全不同。 */
  layerCoverage: Record<JudgeLayer, number | null>;
  requiredGaps: LayerGap[];
  unavailableLayers: LayerProfile[];
  degraded: boolean;
  reasons: string[];
}

export interface JudgeRunResult extends JudgeSummary {
  sessionId: string;
  /** 本次判决在 judge_runs 中的行 id；Update 用它做 source_judgment 追溯。 */
  runId?: number;
  verdicts: CriterionVerdict[];
}

/**
 * 默认能力声明：L0/L1 本机可产出，L2 需要语义评估器，L3 依赖 L2。
 *
 * 注意这里描述的是**未接线时的默认态**：实际生效的 profiles 由
 * `JudgeService.layerProfiles()` 计算 —— 注入 assessor 后 L2 变成
 * `available:true` **且** `required:true`（能判就必须判，未判不得 pass）。
 * 所以不要把这个常量当成运行时真相，它只是「没有任何扩展」时的基线。
 *
 * L2/L3 在基线里 required=false 是有意的：它们未接线不该让每一次正常任务
 * 都变 inconclusive（那会让 inconclusive 变成噪声）。degraded 会因此标出
 * 「本次有判据未执行」，前端必须把这个「通过仅代表已执行判据全绿」讲清楚。
 */
export const DEFAULT_LAYER_PROFILES: LayerProfile[] = [
  { layer: 'L0', available: true, required: true, reason: null },
  { layer: 'L1', available: true, required: true, reason: null },
  {
    layer: 'L2',
    available: false,
    required: false,
    reason: 'assessor_not_wired',
    detail: '语义判据需要 SemanticAssessor；当前进程未注入',
  },
  {
    layer: 'L3',
    available: false,
    required: false,
    reason: 'assessor_not_wired',
    // L3 核对的是「声称完成」与「工具证据」是否一致，依赖最终回答文本，
    // 与 L2 同源（不是依赖 L2 的结论）。没有回答文本就没有可校验的声明。
    detail: '红队判据需要最终回答文本；当前进程未注入 SemanticAssessor，无从提取声明',
  },
];

/** 覆盖率门槛：低于此值，即使零失败也只能判 inconclusive。 */
export const COVERAGE_THRESHOLD = 0.6;

/** 把三态映射为数值，unexec 返回 null（不参与计分）。 */
export function statusToScore(status: VerdictStatus): number | null {
  if (status === 'pass') return 1;
  if (status === 'fail') return 0;
  return null;
}
