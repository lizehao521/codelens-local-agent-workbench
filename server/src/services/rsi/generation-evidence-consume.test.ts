/**
 * 消费侧测试：failure 证据如何进入 evaluateStall 判定 1 与 INV-3 阴影视图。
 *
 * 从 generation-evidence.test.ts 拆出（主文件触 300 行棘轮上限）。
 * 纯函数层验证：不依赖 Db，直接构造 GenerationRecord/ConsistencyShadowRow。
 */
import { describe, it, expect } from 'vitest';
import { buildConsistencyShadow } from './cross-generation-consistency.js';
import { evaluateStall } from './cross-generation-stall.js';
import type { FailureInput } from './cross-generation-stall.js';

describe('消费侧：判定 1（signature_repeated）与 INV-3', () => {
  /** 直接构造带 failure 的多代行，避免依赖落库。 */
  function rowsWithFailure(gens: number[], sig: string | null): Array<{
    generation: number;
    ledgerPath: string | null;
    failure?: FailureInput | null;
  }> {
    return gens.map((g) => ({
      generation: g,
      ledgerPath: `ledger-${g}`,
      failure: sig === null ? null : { rawText: sig },
    }));
  }

  it('相邻两代同签名 → evaluateStall 判 signature_repeated', () => {
    const rows = rowsWithFailure([1, 2], 'TS2345::type mismatch');
    const history = rows.map((r) => ({
      evidence: { level: 'landed' as const, artifactHash: r.ledgerPath ?? undefined },
      ...(r.failure ? { failure: r.failure } : {}),
    }));
    const stall = evaluateStall(history);
    expect(stall.stopped).toBe(true);
    expect(stall.reason).toBe('signature_repeated');
    expect(stall.evidenceChain).toEqual([0, 1]);
  });

  it('improved + 同签名两代 → INV-3 warning（signature_repeated 路径）', () => {
    const v = buildConsistencyShadow(rowsWithFailure([1, 2], 'TS2345::type mismatch'), 'improved');
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]).toMatchObject({ inv: 'INV-3', sev: 'warning' });
    expect(v.violations[0]?.gens).toEqual([1, 2]);
  });

  it('签名不同 → 不误报（无 violation）', () => {
    const v = buildConsistencyShadow(
      [
        { generation: 1, ledgerPath: 'a', failure: { rawText: 'A::x' } },
        { generation: 2, ledgerPath: 'b', failure: { rawText: 'B::y' } },
      ],
      'improved',
    );
    expect(v.violations).toHaveLength(0);
  });

  it('failure=null（unavailable）→ 不得当作"无失败"，但也不得伪造停滞', () => {
    const v = buildConsistencyShadow(
      [
        { generation: 1, ledgerPath: 'a', failure: null },
        { generation: 2, ledgerPath: 'b', failure: null },
      ],
      'improved',
    );
    expect(v.violations).toHaveLength(0);
  });

  it('INV-2 仍在 unavailableChecks，视图不直出 consistent 布尔', () => {
    const v = buildConsistencyShadow(rowsWithFailure([1, 2], 'X::y'), 'not_improved');
    expect(v.unavailableChecks.map((u) => u.inv)).toContain('INV-2');
    expect(v).not.toHaveProperty('consistent');
    expect(v.status).toBe('partial');
  });
});
