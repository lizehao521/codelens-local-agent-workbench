/**
 * RSI 账本离线校验的复算规则（`rsi-loop.md` §5/§6 的「独立离线校验 CLI」）。
 *
 * 这里锁住的是「改任意一层都会在这一层报错」：
 *   evidence 内容 / manifest 原文 / anchor 行字段 / 链式衔接。
 * 不再依赖「下一代 krsi 拒收」这种滞后信号。
 */

import { describe, expect, it } from 'vitest';
import {
  anchorHashOf,
  sha256,
  verifyLedger,
  type AnchorLine,
} from '../src/services/rsi/ledger-verify.js';

interface Fixture {
  anchors: AnchorLine[];
  manifests: Map<number, string>;
  evidence: Map<string, Buffer>;
}

const EVIDENCE_TEXT = '{"sessionId":"s","generation":2,"verdicts":[]}';

function buildChain(generations: number[] = [2, 3]): Fixture {
  const anchors: AnchorLine[] = [];
  const manifests = new Map<number, string>();
  const evidence = new Map<string, Buffer>();
  let prev: string | null = null;

  for (const gen of generations) {
    const rel = `data/rsi/s-gen${gen}-evidence.json`;
    const body = Buffer.from(`${EVIDENCE_TEXT}${gen}`, 'utf8');
    evidence.set(rel, body);
    const manifestJson = JSON.stringify({
      producer: 'codelens-agentkernel',
      generation: gen,
      readings: [{ metric: 'test_pass_rate', value: 0.345, direction: 'up', basis: 1, role: 'objective' }],
      artifacts: [{ path: rel, sha256: sha256(body), bytes: body.byteLength }],
    });
    manifests.set(gen, manifestJson);
    const line: AnchorLine = {
      type: 'anchor',
      generation: gen,
      prev_anchor_hash: prev,
      manifest_hash: sha256(manifestJson),
      verdict: 'not_improved',
      exit_code: 1,
      timestamp: 1_700_000_000_000 + gen,
      anchor_hash: '',
    };
    line.anchor_hash = anchorHashOf(line);
    prev = line.anchor_hash;
    anchors.push(line);
  }
  return { anchors, manifests, evidence };
}

function verify(fixture: Fixture) {
  return verifyLedger({
    anchors: fixture.anchors,
    manifests: fixture.manifests,
    readEvidence: (rel) => fixture.evidence.get(rel) ?? null,
  });
}

describe('verifyLedger', () => {
  it('完整链条全通过', () => {
    const report = verify(buildChain());
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.generations).toEqual([2, 3]);
  });

  it('证据文件被改一个字节就红（evidence_hash_mismatch）', () => {
    const fixture = buildChain();
    const rel = 'data/rsi/s-gen2-evidence.json';
    fixture.evidence.set(rel, Buffer.from('{"sessionId":"s","generation":2,"verdicts":[1]}'));
    const report = verify(fixture);
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.code)).toContain('evidence_hash_mismatch');
    // 只该坏在这一代，不能连坐到下一代
    expect(report.problems.every((p) => p.generation === 2)).toBe(true);
  });

  it('改 anchor 行字段（verdict）会让本行哈希对不上', () => {
    const fixture = buildChain();
    fixture.anchors[1] = { ...fixture.anchors[1], verdict: 'improved' };
    const report = verify(fixture);
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.code)).toContain('anchor_hash_mismatch');
  });

  it('抽掉中间一代会报 chain_break', () => {
    const fixture = buildChain([2, 3, 4]);
    fixture.anchors.splice(1, 1); // 删 g3
    const report = verify(fixture);
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.code)).toContain('chain_break');
  });

  it('manifest 原文与落库不一致会报 manifest_hash_mismatch', () => {
    const fixture = buildChain();
    fixture.manifests.set(2, `${fixture.manifests.get(2)} `);
    const report = verify(fixture);
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.code)).toContain('manifest_hash_mismatch');
  });

  it('库里缺该代 manifest 时明确报 manifest_unavailable，而不是假装通过', () => {
    const fixture = buildChain();
    fixture.manifests.delete(3);
    const report = verify(fixture);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      expect.objectContaining({ generation: 3, code: 'manifest_unavailable' }),
    ]);
  });

  it('空账本不算通过', () => {
    const report = verify({ anchors: [], manifests: new Map(), evidence: new Map() });
    expect(report.ok).toBe(false);
    expect(report.problems[0]?.code).toBe('ledger_empty');
  });
});
