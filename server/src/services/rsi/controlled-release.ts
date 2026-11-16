/**
 * 受控发布开关与判据差分（强化 Judge + Update + RSI 三维）。
 * 集中管理 controlled-release.flag：OFF 时所有 RSI 增量函数级等价官方闭环，
 * ON 时才启用本代证据取数、阈值调整与判据指纹；旗标实时读取、不缓存。
 */
import { existsSync } from 'node:fs';
import { criteriaFingerprint, type RsiCriterionDiff } from './manifest-builder.js';
import { resolveThresholds, DEFAULT_L0_THRESHOLDS } from '../judge/criteria.js';

export const RSI_RELEASE_FLAG = '/workspace/codelens/server/workspace/.runtime_view/controlled-release.flag';

export function rsiReleaseOn(): boolean {
  try { return existsSync(RSI_RELEASE_FLAG); } catch { return false; }
}

/** 受控开关下的本代起点；OFF 返回 undefined（证据取全量）。 */
export function generationStart(start?: number): number | undefined {
  return rsiReleaseOn() ? start : undefined;
}

/** 受控开关下的判据指纹与差分；OFF 返回空对象，调用方展开后等价官方调用。 */
export function releaseCriteria(
  db: { get<T>(sql: string, params?: unknown): T | undefined },
  prevEffective?: Record<string, number>,
): { criteriaSha256?: string; criteriaDiff?: RsiCriterionDiff[] } {
  try {
    if (!rsiReleaseOn()) return {};
    const row = db.get<{ policy_json: string }>('SELECT policy_json FROM policy_versions ORDER BY version DESC LIMIT 1');
    let raw: Record<string, number> = {};
    try { raw = JSON.parse(row?.policy_json ?? '{}').thresholds ?? {}; } catch { raw = {}; }
    const eff = resolveThresholds(raw) as unknown as Record<string, number>;
    const def = DEFAULT_L0_THRESHOLDS as unknown as Record<string, number>;
    const diffs: RsiCriterionDiff[] = [];
    for (const [k, v] of Object.entries(eff)) {
      const base = prevEffective?.[k] ?? def[k];
      if (base === undefined || Math.abs(v - base) < 1e-9) continue;
      const tightened = k.startsWith('min') ? v > base : v < base;
      diffs.push({ id: k, change: tightened ? 'tightened' : 'loosened', note: `${base} -> ${v}` });
    }
    return { criteriaSha256: criteriaFingerprint(eff), criteriaDiff: diffs };
  } catch {
    return {};
  }
}

/** 从上一代 manifest 的 criteria_diff[].note 提取该代生效阈值，作为方向基准。 */
export function prevEffectiveThresholds(row: { next_manifest_json: string | null } | undefined): Record<string, number> {
  if (!row?.next_manifest_json) return {};
  try {
    const prev = JSON.parse(row.next_manifest_json) as { criteria_diff?: { id: string; note: string }[] };
    const out: Record<string, number> = {};
    for (const d of prev.criteria_diff ?? []) {
      const note = d.note ?? '';
      const mOld = /生效\s*([0-9.]+)/.exec(note);
      const m = mOld ?? (/->\s*([0-9.]+)/.exec(note));

      if (m) out[d.id] = Number(m[1]);
    }
    return out;
  } catch {
    return {};
  }
}

/** 受控开关下 tool.success_rate 的阈值调整；null 表示本轮不动阈值。 */
export function rateThresholdDelta(
  failed: { criterion: string }[],
  verdicts: { criterion: string; status: string }[],
  current: number,
): number | null {
  if (failed.some((v) => v.criterion === 'tool.success_rate')) {
    return Math.min(1, Math.round((current + 0.05) * 100) / 100);
  }
  if (verdicts.some((v) => v.criterion === 'tool.success_rate' && v.status === 'pass') && current > 0.6) {
    return Math.max(0.6, Math.round((current - 0.05) * 100) / 100);
  }
  return null;
}
