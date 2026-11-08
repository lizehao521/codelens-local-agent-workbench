/**
 * Manifest builder — Agent CriterionVerdict[] → RSI Manifest.
 *
 * 这是 L1 机械桥的翻译层：把 JudgeService 产出的判据塔 verdicts（三态 + 可选 score）
 * 转成 microkernel-rsi 的 Manifest 结构，喂给 krsi CLI 的 Judge(prev, next) 做跨代对比。
 *
 * 设计约束（来自 microkernel-rsi 的 R1 判据 + RSI 契约）：
 *  - 同名 metric 跨两代必须完全一致（R5 判据只比同名对）
 *  - direction 必须是 "up" 或 "down"
 *  - basis 只能是 1-5（measured/relayed/estimated/model_says/absent）
 *  - absent 必须带 why_absent
 *  - relayed 必须带 source
 *  - 比率型读数带 denominator（正数）
 *
 * 本模块是纯函数，无副作用，无 DB 依赖 —— 可以单测钉死。
 */

import { createHash } from 'node:crypto';
import type { CriterionVerdict } from '../judge/types.js';
import { DEFAULT_L0_THRESHOLDS } from '../judge/criteria.js';

// ── RSI Manifest 类型镜像（与 microkernel-rsi/risk 包同构）────────────────

const BASIS = {
  Measured: 1, // 实测（Agent 的工具调用、审批、预算消耗，全部是实测）
  Relayed: 2,
  Estimated: 3,
  ModelSays: 4,
  Absent: 5,
} as const;

/**
 * 每类判据在 RSI 里对应什么 metric 名、方向、basis。
 * 这张表是 L1 桥接的核心契约 —— 同名 metric 跨两代必须完全一致，
 * 所以这里的字符串就是"判据名 → RSI 指标名"的唯一真相源。
 *
 * 为什么这些都 basis=1（measured）：
 *   Agent 的 tool.success_rate 是从真跑的 tool_calls 算出来的
 *   approval.friction 是从真发生的审批算出来的
 *   budget.efficiency 是从真消耗的 token 算出来的
 *   task.terminal / loop.health 是真运行期终止 / 熔断事件
 *   —— 全部是实测，不是转述、估算或模型自述。
 */
const METRIC_MAP: Record<
  string,
  { metric: string; direction: 'up' | 'down'; basis: number }
> = {
  'tool.success_rate': {
    metric: 'tool_success_rate',
    direction: 'up',
    basis: BASIS.Measured,
  },
  'approval.friction': {
    metric: 'approval_friction',
    direction: 'down',
    basis: BASIS.Measured,
  },
  'budget.efficiency': {
    metric: 'budget_efficiency',
    direction: 'down',
    basis: BASIS.Measured,
  },
  'task.terminal': {
    metric: 'task_terminal',
    direction: 'up',
    basis: BASIS.Measured,
  },
  'loop.health': {
    metric: 'loop_health',
    direction: 'up',
    basis: BASIS.Measured,
  },
  // ── 写闸覆盖率（连续值 0-1）──
  // 让「Agent 自己补测试」这件事在 RSI 里可见：每补一个工具，
  // tool_write_coverage 就严格上升一格，krsi 的 R5 能据此判 improved。
  // 若只保留二值 pass/fail，补到 9/10 仍然是 fail，跨代完全看不出进步。
  'tool.discipline.write_gate': {
    metric: 'tool_write_coverage',
    direction: 'up',
    basis: BASIS.Measured,
  },
  // ── L2 深判（LLM 语义裁判）──
  // basis=2 Relayed：来自固定 prompt + 固定模型 + temperature=0 的 LLM 判定，
  // 同一输入复跑会得到相同分数，本质上是"relayed from a known process"，
  // 不是瞎猜的 model_says（basis=4）。
  'semantic.completion': {
    metric: 'semantic_completion',
    direction: 'up',
    basis: BASIS.Relayed,
  },
};

/** Agent 判据名 → RSI metric 的反向查表（供测试断言用）。 */
export const KNOWN_CRITERIA = Object.keys(METRIC_MAP);

/**
 * 判据集指纹 —— 对整座判据塔的**定义**做真实 sha256。
 *
 * 为什么要真实指纹而不是固定常量：krsi 的 R2 判据靠 criteria_sha256 判断
 * 「这一代有没有偷偷改判据」。如果指纹是固定假值，那么无论判据被放宽、
 * 被删、被替换成永真闸，krsi 都看不出来 —— 自证体系当场失效。
 *
 * 指纹覆盖：每条判据的名字 / 对应 metric / 方向 / basis + 生效阈值。
 * 判据集不变 → 指纹逐代稳定（不会误报改判据）；任一判据或阈值变动 → 指纹变，
 * 跨代 diff 就能被 krsi 抓到。
 */
export function criteriaFingerprint(
  thresholds?: Record<string, number>,
): string {
  const effective = thresholds ?? (DEFAULT_L0_THRESHOLDS as unknown as Record<string, number>);
  const descriptor = {
    version: 2,
    metrics: Object.entries(METRIC_MAP)
      .map(([criterion, c]) => ({
        criterion,
        metric: c.metric,
        direction: c.direction,
        basis: c.basis,
      }))
      .sort((a, b) => a.criterion.localeCompare(b.criterion)),
    thresholds: Object.keys(effective)
      .sort()
      .map((k) => [k, (effective as Record<string, number>)[k]]),
  };
  return sha256Hex(JSON.stringify(descriptor));
}

/** 当前判据集指纹（模块加载时算一次，供默认值使用）。 */
export const CRITERIA_FINGERPRINT = criteriaFingerprint();

// ── RSI Manifest 类型 ── 必须与 microkernel-rsi/risk.go 的 JSON 形状对齐

export interface RsiArtifact {
  path: string;
  sha256: string;
  bytes: number;
}

export interface RsiCriterionDiff {
  id: string;
  change: 'tightened' | 'loosened' | 'added' | 'removed';
  note?: string;
}

export interface RsiReading {
  metric: string;
  n: number;
  basis: number; // 1-5
  source?: string;
  why_absent?: string;
  direction: 'up' | 'down';
  denominator?: number;
}

export interface RsiManifest {
  producer: string;
  generation: number;
  artifacts: RsiArtifact[];
  criteria_sha256: string;
  criteria_diff: RsiCriterionDiff[];
  readings: RsiReading[];
  claim: string;
}

export interface BuildManifestInput {
  producer: string;
  generation: number;
  /** Agent 判据塔的单轮判决。 */
  verdicts: CriterionVerdict[];
  /** 可选：产物指纹（从 tool_results / fs-write 汇总的 sha256）。L1 先不传也行 —— R2 会拒收同字节假改进。 */
  artifacts?: RsiArtifact[];
  /** 可选：判据集的 sha256（当前版本可先填固定值 'agentkernel/criteria@L1'）。 */
  criteriaSha256?: string;
  /** 可选：判据变更 diff。L1 判据集固定，为空数组。 */
  criteriaDiff?: RsiCriterionDiff[];
  /** 可选：简短声明，默认由 generation 自动合成。 */
  claim?: string;
}

/**
 * 把 Agent 判据塔 verdicts 转成 RSI readings 数组。
 *
 * 三条规则：
 *   1. 未知判据名 → 跳过（不进 readings，R5 判据互比时两边都没这个指标，不影响改进判定）
 *   2. 已知判据 + 有 score → 直接用 score（连续值）
 *   3. 已知判据 + 无 score → 用 statusToScore 从三态折 0/1/null
 *      - pass → n=1, basis=measured
 *      - fail → n=0, basis=measured
 *      - unexec → basis=absent + why_absent="agent_verdict_unexec"
 *
 * 排序：按 METRIC_MAP 里的声明顺序（deterministic，便于 diff）。
 */
export function verdictsToReadings(verdicts: CriterionVerdict[]): RsiReading[] {
  const byCriterion = new Map(verdicts.map((v) => [v.criterion, v]));
  const out: RsiReading[] = [];

  for (const [criterion, conf] of Object.entries(METRIC_MAP)) {
    const verdict = byCriterion.get(criterion);
    if (!verdict) continue;
    if (verdict.score === undefined || verdict.score === null || !Number.isFinite(verdict.score)) {
      // 没有 score 的判据（task.terminal / loop.health 二值 pass/fail）不进 RSI readings。
      // krsi R5 判据要求每一个 metric 严格变好才算 improved，
      // 二值信号在 Agent 判据塔里是区分 pass/fail 用的（三态→决策），
      // 但作为 RSI 跨代互比指标太粗 —— pass→pass = 1→1 永远"没变"，
      // fail→pass = 0→1 算变好，但不足以区分"小幅度连续改进"。
      // Agent 自己的判定逻辑里这些二值判据照常跑，
      // 只是不进 RSI readings 供 krsi 做代际对比。
      continue;
    }

    out.push({
      metric: conf.metric,
      n: verdict.score,
      basis: conf.basis,
      direction: conf.direction,
    });
  }

  return out;
}

/**
 * 构建完整 RSI Manifest。
 *
 * criteria_sha256：对判据集定义 + 生效阈值做真实 sha256（criteriaFingerprint）。
 *   判据不变则逐代稳定；任一判据/阈值变动则跨代可见 —— 这是 R2 能抓「偷改判据」的前提。
 * criteria_diff：本代相对上代的判据变更（当前由桥接层填，默认空数组）。
 * artifacts：调用方传真实原像（path + 真 sha256 + 真字节数）。不传时对 readings
 *   JSON 做真 sha256 兜底 —— 绝不使用固定占位串，否则 R4「可锚」形同虚设。
 */
export function buildManifest(input: BuildManifestInput): RsiManifest {
  const readings = verdictsToReadings(input.verdicts);

  // artifacts 必须是**可复核的真原像**，不是占位符。
  // 调用方（RsiBridgeService）会把本轮判决证据落盘后传进来：
  //   { path: 证据文件的相对路径, sha256: 文件内容的真 sha256, bytes: 真实字节数 }
  // 这样 krsi 的 R4「可锚」判据才真的是在验「这个 manifest 指着一个没被篡改的
  // 真实证据文件」，而不是在验一个 64 个 0 的占位串。
  //
  // 没传 artifacts 时退回「readings 原像」：对 readings 的 JSON 做真 sha256，
  // bytes 用真实字节数。注意**不含 generation** —— 两代读数完全相同时产物
  // 指纹也必须相同，这正是 krsi 该拒收的情形；把 generation 混进哈希
  // 等于伪造差异，会把「原地踏步」洗成「有新产物」。
  const artifacts =
    input.artifacts && input.artifacts.length > 0
      ? input.artifacts
      : (() => {
          const body = JSON.stringify({ readings });
          return [
            {
              path: `agentkernel/gen${input.generation}-readings`,
              sha256: sha256Hex(body),
              bytes: Buffer.byteLength(body, 'utf8'),
            },
          ];
        })();

  return {
    producer: input.producer,
    generation: input.generation,
    artifacts,
    criteria_sha256: input.criteriaSha256 ?? criteriaFingerprint(),
    criteria_diff: input.criteriaDiff ?? [],
    readings,
    claim: input.claim ?? `Agent 第 ${input.generation} 代判据塔判决`,
  };
}

/** 真实 sha256（64 hex）。RSI 的 R4/R6 验的是密码学哈希，不能用弱哈希顶替。 */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
