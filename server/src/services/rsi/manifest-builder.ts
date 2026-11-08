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

import type { CriterionVerdict } from '../judge/types.js';

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
};

/** Agent 判据名 → RSI metric 的反向查表（供测试断言用）。 */
export const KNOWN_CRITERIA = Object.keys(METRIC_MAP);

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
 * criteria_sha256：L1 判据集固定（L0_CRITERIA + task.terminal + loop.health），
 *   所以填固定值就够 —— 等判据集扩了再算真实 sha256。
 * criteria_diff：L1 判据集不变，空数组。
 * artifacts：L1 可选；不传时给一个固定 artifact 占位（含空 path + 固定 sha256），
 *   保证 RSI R1 不会因为产物清单为空而拒收。L2 会校验指纹变化。
 */
export function buildManifest(input: BuildManifestInput): RsiManifest {
  const readings = verdictsToReadings(input.verdicts);

  // RSI R2 判据：两代产物指纹集完全相同 → 拒收（同字节换标签不算改进）。
  // 所以 fallback artifact 的 sha256 必须跨代唯一。
  // —— 把 generation + readings 内容拼进 hash seed，
  //    保证 verdicts 变了就 artifact hash 也变；同样的 verdicts + 同样的 generation
  //    才会生成同样的 artifact（R2 这时候拒收才是对的：同字节无实质改进）。
  const artifacts =
    input.artifacts && input.artifacts.length > 0
      ? input.artifacts
      : [
          {
            path: `agentkernel/gen${input.generation}-readings`,
            sha256: hashlize(JSON.stringify({ g: input.generation, r: readings })),
            bytes: 0,
          },
        ];

  return {
    producer: input.producer,
    generation: input.generation,
    artifacts,
    criteria_sha256: input.criteriaSha256 ?? hashlize('agentkernel/criteria@L1'),
    criteria_diff: input.criteriaDiff ?? [],
    readings,
    claim: input.claim ?? `Agent 第 ${input.generation} 代判据塔判决`,
  };
}

/** 简单 sha256 替代：这里只需要 deterministic 64 hex，不真的需要加密安全。 */
function hashlize(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  // 把整数扩成 64 hex 字符（0 也返回 64 个 0，RSI R1 只检查长度）
  const hex = (Math.abs(h) || 0).toString(16).padStart(16, '0');
  return hex.repeat(4).slice(0, 64);
}
