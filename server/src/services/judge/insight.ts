/**
 * 强化内核洞察视图的聚合层（纯函数，零 IO）。
 *
 * 存在的理由：四个机制都在跑，但使用者看不见它们在做什么 ——
 * 四层判据哪几层真的在判、规则判与 LLM 深判各占多少、深判花了多少 token、
 * 本轮注入了哪几条经验又裁掉了哪几条。这些信息散落在 selfCheck、listRuns、
 * 每条快照的 context_json、以及一个没有任何出口的 getInjectableView() 里。
 *
 * 三条不可让步的性质：
 *  1. **纯函数**：同样的输入必得同样的输出，所有 IO（SQL、解压）由调用方完成。
 *     这样「视图算错了」和「数据取错了」可以分开定位。
 *  2. **有界**：深判花费只能靠解压 context_json 得到，扫描条数由调用方传常量上限，
 *     本模块绝不自己去翻全表。
 *  3. **不参与定档**：这里只做展示，任何数字都不回流到 summarize/replay。
 */

import type { JudgeLayer, LayerProfile, VerdictStatus } from './types.js';
import type { JudgeRunContextSnapshot } from './replay.js';
import type { TierBucket } from '../../repositories/judge.repository.js';

/** 深判花费的扫描上界。深判是手动触发的抽样行为，200 条已覆盖近乎全部历史。 */
export const MAX_DEEP_USAGE_SCAN = 200;
export const DEFAULT_INSIGHT_LIMIT = 50;
export const MAX_INSIGHT_LIMIT = 200;

/** 深判行快照里的 `deep` 块（写快照时由 judgeDeep 塞进去的）。 */
interface DeepMeta {
  assessorId?: string;
  promptTemplateVersion?: number;
  provider?: { providerId?: string; model?: string };
  usage?: { promptTokens?: number; completionTokens?: number };
  latencyMs?: number;
  failure?: string | null;
}

export type DeepSnapshot = JudgeRunContextSnapshot & { deep?: DeepMeta };

export interface InsightLayerItem {
  layer: JudgeLayer;
  available: boolean;
  required: boolean;
  reason: string | null;
  detail: string | null;
  /** 最近一次**规则**判决里这一层的覆盖率；没有快照时为 null（不是 0）。 */
  lastRunCoverage: number | null;
}

export interface KernelInsight {
  generatedAt: number;
  window: {
    limit: number;
    runsScanned: number;
    runsTruncated: boolean;
    deepScanLimit: number;
    deepScanned: number;
    deepTruncated: boolean;
  };
  layers: {
    canary: { status: VerdictStatus; goodScore: number; badScore: number; detail: string };
    coverageThreshold: number;
    items: InsightLayerItem[];
    unavailableLayers: Array<{ layer: JudgeLayer; reason: string; detail?: string }>;
  };
  distribution: {
    unit: 'row';
    rules: TierBucket & { lastRunId: number | null; lastCreatedAt: number | null };
    deep: TierBucket & {
      lastRunId: number | null;
      lastCreatedAt: number | null;
      coveredOriginals: number;
      repeatParents: number;
    };
    totalRuns: number;
  };
  deepUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    rowsWithUsage: number;
    rowsWithoutUsage: number;
    avgLatencyMs: number | null;
    failures: Record<string, number>;
    byModel: Array<{ model: string; runs: number; promptTokens: number; completionTokens: number }>;
  };
  injection: {
    version: number;
    lessons: string[];
    evicted: string[];
    chars: number;
    policyLessons: number;
    budget: { maxLessons: number; maxChars: number } | null;
  } | null;
  errors: string[];
}

export interface InsightInput {
  canary: { status: VerdictStatus; goodScore: number; badScore: number; detail: string };
  coverageThreshold: number;
  profiles: LayerProfile[];
  unavailableLayers?: Array<{ layer: JudgeLayer; reason: string; detail?: string }>;
  latestRulesSnapshot: JudgeRunContextSnapshot | null;
  distribution: {
    rules: TierBucket & { lastRunId: number | null; lastCreatedAt: number | null };
    deep: TierBucket & {
      lastRunId: number | null;
      lastCreatedAt: number | null;
      coveredOriginals: number;
      repeatParents: number;
    };
  };
  deepRows: Array<{ id: number; snapshot: DeepSnapshot | null }>;
  limit: number;
  runsScanned: number;
  totalRuns: number;
  injection: KernelInsight['injection'];
  errors?: string[];
}

const LAYER_ORDER: JudgeLayer[] = ['L0', 'L1', 'L2', 'L3'];

/**
 * 层清单恒为 4 条、顺序固定。
 *
 * 缺层用默认值补齐而不是「有几个报几个」：这个视图的第一句话就是
 * 「四层现在各是什么状态」，少一行会被读成「这一层不存在」。
 */
function buildLayerItems(
  profiles: LayerProfile[],
  snapshot: JudgeRunContextSnapshot | null,
): InsightLayerItem[] {
  const byLayer = new Map(profiles.map((p) => [p.layer, p]));
  return LAYER_ORDER.map((layer) => {
    const profile = byLayer.get(layer);
    const coverage = snapshot?.layerCoverage?.[layer];
    return {
      layer,
      available: profile?.available ?? false,
      required: profile?.required ?? false,
      reason: profile?.reason ?? null,
      detail: profile?.detail ?? null,
      // 关键：null 就是 null。写成 0 会让「没有快照」看起来像「覆盖率是 0」。
      lastRunCoverage: typeof coverage === 'number' ? coverage : null,
    };
  });
}

function aggregateDeepUsage(rows: Array<{ id: number; snapshot: DeepSnapshot | null }>): KernelInsight['deepUsage'] {
  let promptTokens = 0;
  let completionTokens = 0;
  let rowsWithUsage = 0;
  let rowsWithoutUsage = 0;
  let latencySum = 0;
  let latencyCount = 0;
  const failures: Record<string, number> = {};
  const byModel = new Map<string, { runs: number; promptTokens: number; completionTokens: number }>();

  for (const row of rows) {
    const deep = row.snapshot?.deep;
    if (!deep) {
      rowsWithoutUsage += 1;
      continue;
    }

    const prompt = deep.usage?.promptTokens ?? 0;
    const completion = deep.usage?.completionTokens ?? 0;
    if (prompt + completion > 0) {
      rowsWithUsage += 1;
      promptTokens += prompt;
      completionTokens += completion;
    } else {
      rowsWithoutUsage += 1;
    }

    if (typeof deep.latencyMs === 'number' && Number.isFinite(deep.latencyMs)) {
      latencySum += deep.latencyMs;
      latencyCount += 1;
    }

    // null 记 'none'：不记的话「成功的深判」在分布里完全消失，
    // 只剩失败原因，读起来像「深判从不成功」。
    const failureKey = deep.failure ?? 'none';
    failures[failureKey] = (failures[failureKey] ?? 0) + 1;

    const model = deep.provider?.model ?? 'unknown';
    const bucket = byModel.get(model) ?? { runs: 0, promptTokens: 0, completionTokens: 0 };
    bucket.runs += 1;
    bucket.promptTokens += prompt;
    bucket.completionTokens += completion;
    byModel.set(model, bucket);
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    rowsWithUsage,
    rowsWithoutUsage,
    avgLatencyMs: latencyCount === 0 ? null : Math.round(latencySum / latencyCount),
    failures,
    byModel: [...byModel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens)),
  };
}

export function aggregateInsight(input: InsightInput): KernelInsight {
  const deepScanned = input.deepRows.length;
  const deepTruncated = deepScanned >= MAX_DEEP_USAGE_SCAN;

  return {
    generatedAt: Date.now(),
    window: {
      limit: input.limit,
      runsScanned: input.runsScanned,
      runsTruncated: false,
      deepScanLimit: MAX_DEEP_USAGE_SCAN,
      deepScanned,
      deepTruncated,
    },
    layers: {
      canary: input.canary,
      coverageThreshold: input.coverageThreshold,
      items: buildLayerItems(input.profiles, input.latestRulesSnapshot),
      unavailableLayers: input.unavailableLayers ?? [],
    },
    distribution: {
      unit: 'row',
      rules: input.distribution.rules,
      deep: input.distribution.deep,
      totalRuns: input.totalRuns,
    },
    deepUsage: aggregateDeepUsage(input.deepRows),
    injection: input.injection,
    errors: input.errors ?? [],
  };
}
