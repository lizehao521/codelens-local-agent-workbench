/**
 * E：审批疲劳消解（有红线的去重）。
 *
 * 只在同一 run + 同一目录 + 同一操作类型 + 可逆写入时，第二次起沿用上一次授权。
 * 红线（永不去重）：
 *  - 不可逆操作（effect.reversible === false）；
 *  - 敏感路径（.env / 密钥 / 凭据等，复用 sensitive-path 判定）；
 *  - 越界目录（不在 sandboxRoot 也不在 allowedDirs 内）。
 * 每次沿用都会把原始授权 id / 步骤写进 RunState（撤销时可追溯）。
 */

import path from 'node:path';
import type { EffectPreview } from '../../types/tool.js';
import { isSensitivePath } from '../tools/sensitive-path.js';

export interface DedupGrant {
  grantId: string;
  step: number;
  at: number;
}

export interface DedupContext {
  runId: string;
  toolName: string;
  effect: EffectPreview | null;
  sandboxRoot: string;
  allowedDirs: string[];
}

export interface DedupEligibility {
  key: string;
  dir: string;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class ApprovalDedupService {
  private readonly grants = new Map<string, DedupGrant>();

  /**
   * 返回可去重的键；null 表示命中红线或不是可逆写入，必须每次前置审批。
   * 键 = runId | 目录 | 操作类型。
   */
  keyFor(ctx: DedupContext): DedupEligibility | null {
    const effect = ctx.effect;
    if (!effect || !effect.reversible) return null;
    if (effect.items.length === 0) return null;
    if (effect.items.some((item) => item.kind !== 'file' && item.kind !== 'dir')) return null;

    const dirs = new Set<string>();
    for (const item of effect.items) {
      const abs = path.resolve(item.path);
      if (isSensitivePath(abs)) return null;
      const inside =
        isInside(ctx.sandboxRoot, abs) ||
        ctx.allowedDirs.some((dir) => isInside(dir, abs));
      if (!inside) return null;
      dirs.add(path.dirname(abs));
    }
    // 同一目录：多个目标目录时不去重（避免把 A 目录的授权挪用到 B 目录）。
    if (dirs.size !== 1) return null;
    const dir = [...dirs][0] as string;
    return { key: `${ctx.runId}|${dir}|${ctx.toolName}`, dir };
  }

  lookup(key: string): DedupGrant | null {
    return this.grants.get(key) ?? null;
  }

  remember(key: string, grantId: string, step: number): void {
    if (!grantId) return;
    this.grants.set(key, { grantId, step, at: Date.now() });
  }

  clearRun(runId: string): void {
    for (const key of this.grants.keys()) {
      if (key.startsWith(`${runId}|`)) this.grants.delete(key);
    }
  }
}
