/**
 * 定档：把逐条判据汇总成 run 级结论（判据塔 v2）。
 *
 * 单独成文件是因为 replay 也要用它重算 —— 若让它留在 judge.service 里，
 * JudgeService → replay → JudgeService 会形成模块环，读代码的人得先解环
 * 才能确认「复算用的和判档用的是不是同一个函数」。
 */

import {
  COVERAGE_THRESHOLD,
  DEFAULT_LAYER_PROFILES,
  statusToScore,
  type CriterionVerdict,
  type JudgeLayer,
  type JudgeSummary,
  type LayerGap,
  type LayerProfile,
  type RunVerdict,
} from './types.js';

export interface SummarizeOptions {
  /** 覆盖率门槛，默认 COVERAGE_THRESHOLD。 */
  coverageThreshold?: number;
  /** 单层最低覆盖率，默认 0.5：一层只跑了三成，不能当作这一层有所覆盖。 */
  layerMinCoverage?: number;
}

const LAYERS: JudgeLayer[] = ['L0', 'L1', 'L2', 'L3'];

/**
 * 汇总判据 → run 级结论（判据塔 v2）。
 *
 * 与 v1 的差别只有一处，但它是关键：**分母只算 available 层**。
 * v1 把恒不执行的 L2/L3 也算进分母，于是 5/8=0.625 就跨过了 0.6 的门槛 ——
 * 判据塔跑了一半，却被算成「测得差不多了」。
 *
 * 定档顺序不可调换：
 *   1. 非 L1 判据 fail ⇒ fail（失败优先于覆盖率，不能被弱覆盖稀释）
 *   2. L1 fail         ⇒ inconclusive + judge_self_check_failed
 *                        （判据塔自身故障，不是任务失败：写成 fail 会让
 *                          自证故障永久入库并污染经验有效性的分母）
 *   3. 必需层有缺口    ⇒ inconclusive + required_layer_unexecuted
 *   4. 覆盖不足        ⇒ inconclusive + coverage_below_threshold
 *   5. 其余            ⇒ pass
 */
export function summarize(
  verdicts: CriterionVerdict[],
  profiles: LayerProfile[] = DEFAULT_LAYER_PROFILES,
  opts: SummarizeOptions = {},
): JudgeSummary {
  const threshold = opts.coverageThreshold ?? COVERAGE_THRESHOLD;
  const layerMin = opts.layerMinCoverage ?? 0.5;

  const profileOf = (layer: JudgeLayer): LayerProfile =>
    profiles.find((p) => p.layer === layer) ?? {
      layer,
      available: false,
      required: false,
      reason: 'not_declared',
    };

  // ── 双口径：主口径只数 available 层，全塔口径只用于展示 ────────────────
  const counted = verdicts.filter((v) => profileOf(v.layer).available);
  const total = counted.length;
  const executed = counted.filter((v) => v.status !== 'unexec').length;
  const coverage = total === 0 ? 0 : round3(executed / total);

  const towerTotal = verdicts.length;
  const towerExecuted = verdicts.filter((v) => v.status !== 'unexec').length;
  const towerCoverage = towerTotal === 0 ? 0 : round3(towerExecuted / towerTotal);

  const layerCoverage: Record<JudgeLayer, number | null> = { L0: null, L1: null, L2: null, L3: null };
  for (const layer of LAYERS) {
    const profile = profileOf(layer);
    if (!profile.available) {
      // 不可用层是「未知」（null），不是「全红」（0）：0 会被误读成判据全挂。
      layerCoverage[layer] = null;
      continue;
    }
    const inLayer = verdicts.filter((v) => v.layer === layer);
    if (inLayer.length === 0) {
      layerCoverage[layer] = null;
      continue;
    }
    const layerExecuted = inLayer.filter((v) => v.status !== 'unexec').length;
    layerCoverage[layer] = round3(layerExecuted / inLayer.length);
  }

  // ── 定档信号拆分：任务失败 与 自证故障 绝不可混为一谈 ──────────────────
  const hasTaskFail = verdicts.some((v) => v.status === 'fail' && v.layer !== 'L1');
  const selfCheckBad = verdicts.some((v) => v.layer === 'L1' && v.status === 'fail');

  const requiredGaps: LayerGap[] = [];
  for (const profile of profiles) {
    if (!profile.required) continue;
    if (!profile.available) {
      // fail-closed：profile 配错（required 却没接线）也必须挡在 pass 之外。
      requiredGaps.push({ layer: profile.layer, reason: 'unavailable' });
      continue;
    }
    const inLayer = verdicts.filter((v) => v.layer === profile.layer);
    const layerExecuted = inLayer.filter((v) => v.status !== 'unexec').length;
    if (inLayer.length === 0 || layerExecuted === 0) {
      requiredGaps.push({ layer: profile.layer, reason: 'unexecuted' });
      continue;
    }
    if ((layerCoverage[profile.layer] ?? 0) < layerMin) {
      requiredGaps.push({ layer: profile.layer, reason: 'below_layer_min' });
    }
  }

  const reasons: string[] = [];
  let verdict: RunVerdict;
  if (hasTaskFail) {
    verdict = 'fail';
  } else if (selfCheckBad) {
    verdict = 'inconclusive';
    reasons.push('judge_self_check_failed');
  } else if (requiredGaps.length > 0) {
    verdict = 'inconclusive';
    reasons.push('required_layer_unexecuted');
  } else if (coverage < threshold) {
    verdict = 'inconclusive';
    reasons.push('coverage_below_threshold');
  } else {
    verdict = 'pass';
  }

  // L1 的分数是「判别力差距」，不是任务质量，混进 score 会把判决分数虚高；
  // weightExcluded 的判据是「不适用」（如语义层对解释型目标不判完成度），
  // 它照样算 executed，但不该被当成 1.0 拉高均值。
  const scored = counted
    .filter((v) => v.layer !== 'L1' && v.weightExcluded !== true)
    .map((v) => statusToScore(v.status))
    .filter((s): s is number => s !== null);
  const score = scored.length === 0 ? 0 : round3(scored.reduce((a, b) => a + b, 0) / scored.length);

  return {
    verdict,
    score,
    coverage,
    executed,
    total,
    towerCoverage,
    towerExecuted,
    towerTotal,
    layerCoverage,
    requiredGaps,
    unavailableLayers: profiles.filter((p) => !p.available),
    // degraded 说的是「本次判决被削弱了」，不是「系统能力不全」：
    // 后者由 unavailableLayers 表达。旧口径（任一 profile 不可用）会因 L3
    // 永不可用而恒为 true，等于一个没有信息量的常量。
    degraded: counted.some((v) => v.status === 'unexec'),
    reasons,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
